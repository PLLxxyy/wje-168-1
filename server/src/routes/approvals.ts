import { Router } from 'express';
import db from '../database';
import { authenticateToken, requireRole } from '../middleware/auth';
import { TimeEntryWithUser } from '../types';

const router = Router();

const getWeekStart = (dateStr: string): string => {
  const date = new Date(dateStr);
  const day = date.getDay();
  const diff = date.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(date);
  monday.setDate(diff);
  return monday.toISOString().split('T')[0];
};

router.get('/pending', authenticateToken, requireRole('supervisor', 'admin'), (req, res) => {
  if (!req.user) return res.status(401).json({ error: '未认证' });

  const { type } = req.query;

  let sql = `
    SELECT te.*, p.name as project_name, u.name as user_name, u.department
    FROM time_entries te
    LEFT JOIN projects p ON te.project_id = p.id
    LEFT JOIN users u ON te.user_id = u.id
    WHERE te.status = 'pending'
  `;

  const params: any[] = [];

  if (type === 'overtime') {
    sql += ' AND te.is_overtime = 1';
  } else if (type === 'normal') {
    sql += ' AND te.is_overtime = 0';
  }

  if (req.user.role === 'supervisor') {
    sql += ' AND u.supervisor_id = ?';
    params.push(req.user.userId);
  }

  sql += ' ORDER BY te.entry_date DESC';

  const entries = db.prepare(sql).all(...params) as TimeEntryWithUser[];

  const grouped = entries.reduce((acc: any, entry) => {
    const key = `${entry.user_id}_${entry.entry_date}`;
    if (!acc[key]) {
      acc[key] = {
        user_id: entry.user_id,
        user_name: entry.user_name,
        department: entry.department,
        entry_date: entry.entry_date,
        entries: [],
        total_hours: 0,
        is_overtime: entry.is_overtime
      };
    }
    acc[key].entries.push(entry);
    acc[key].total_hours += entry.hours;
    if (entry.is_overtime === 1) {
      acc[key].is_overtime = 1;
    }
    return acc;
  }, {});

  res.json(Object.values(grouped));
});

router.get('/pending/weekly', authenticateToken, requireRole('supervisor', 'admin'), (req, res) => {
  if (!req.user) return res.status(401).json({ error: '未认证' });

  const { type } = req.query;

  let sql = `
    SELECT te.*, p.name as project_name, u.name as user_name, u.department
    FROM time_entries te
    LEFT JOIN projects p ON te.project_id = p.id
    LEFT JOIN users u ON te.user_id = u.id
    WHERE te.status = 'pending'
  `;

  const params: any[] = [];

  if (type === 'overtime') {
    sql += ' AND te.is_overtime = 1';
  } else if (type === 'normal') {
    sql += ' AND te.is_overtime = 0';
  }

  if (req.user.role === 'supervisor') {
    sql += ' AND u.supervisor_id = ?';
    params.push(req.user.userId);
  }

  sql += ' ORDER BY te.entry_date DESC';

  const entries = db.prepare(sql).all(...params) as TimeEntryWithUser[];

  const weeklyGroups = entries.reduce((acc: any, entry) => {
    const weekStart = getWeekStart(entry.entry_date);
    const key = `${entry.user_id}_${weekStart}`;
    if (!acc[key]) {
      acc[key] = {
        user_id: entry.user_id,
        user_name: entry.user_name,
        department: entry.department,
        week_start: weekStart,
        daily_groups: {},
        total_hours: 0,
        normal_hours: 0,
        overtime_hours: 0,
        has_overtime: false,
        total_entries: 0
      };
    }
    const dayKey = entry.entry_date;
    if (!acc[key].daily_groups[dayKey]) {
      acc[key].daily_groups[dayKey] = {
        entry_date: dayKey,
        entries: [],
        total_hours: 0,
        is_overtime: entry.is_overtime
      };
    }
    acc[key].daily_groups[dayKey].entries.push(entry);
    acc[key].daily_groups[dayKey].total_hours += entry.hours;
    acc[key].total_hours += entry.hours;
    acc[key].total_entries += 1;
    if (entry.is_overtime === 1) {
      acc[key].has_overtime = true;
      acc[key].overtime_hours += entry.hours;
      acc[key].daily_groups[dayKey].is_overtime = 1;
    } else {
      acc[key].normal_hours += entry.hours;
    }
    return acc;
  }, {});

  const result = Object.values(weeklyGroups).map((group: any) => ({
    ...group,
    daily_groups: Object.values(group.daily_groups).sort((a: any, b: any) => 
      a.entry_date.localeCompare(b.entry_date)
    )
  }));

  res.json(result);
});

router.post('/:id/approve', authenticateToken, requireRole('supervisor', 'admin'), (req, res) => {
  if (!req.user) return res.status(401).json({ error: '未认证' });

  const { comment } = req.body;
  const timeEntryId = Number(req.params.id);

  const entry = db.prepare('SELECT * FROM time_entries WHERE id = ?').get(timeEntryId);
  if (!entry) {
    return res.status(404).json({ error: '记录不存在' });
  }

  const updateStmt = db.prepare('UPDATE time_entries SET status = ? WHERE id = ?');
  const approvalStmt = db.prepare(`
    INSERT INTO approvals (time_entry_id, approver_id, status, comment)
    VALUES (?, ?, ?, ?)
  `);
  const notificationStmt = db.prepare(`
    INSERT INTO notifications (user_id, type, title, content, related_id)
    VALUES (?, ?, ?, ?, ?)
  `);

  const entryData = entry as any;
  const isOvertime = entryData.is_overtime === 1;

  const transaction = db.transaction(() => {
    updateStmt.run('approved', timeEntryId);
    approvalStmt.run(timeEntryId, req.user!.userId, 'approved', comment || null);
    
    const notificationType = isOvertime ? 'overtime_approval' : 'approval';
    const notificationTitle = isOvertime ? '加班审批通过' : '工时审批通过';
    const notificationContent = isOvertime 
      ? `您 ${entryData.entry_date} 的加班申请已通过审批`
      : `您 ${entryData.entry_date} 的工时已通过审批`;
    
    notificationStmt.run(
      entryData.user_id,
      notificationType,
      notificationTitle,
      notificationContent,
      timeEntryId
    );
  });

  try {
    transaction();
    res.json({ success: true, status: 'approved', is_overtime: isOvertime });
  } catch (error) {
    res.status(500).json({ error: '审批失败' });
  }
});

router.post('/:id/reject', authenticateToken, requireRole('supervisor', 'admin'), (req, res) => {
  if (!req.user) return res.status(401).json({ error: '未认证' });

  const { comment } = req.body;
  const timeEntryId = Number(req.params.id);

  const entry = db.prepare('SELECT * FROM time_entries WHERE id = ?').get(timeEntryId);
  if (!entry) {
    return res.status(404).json({ error: '记录不存在' });
  }

  const updateStmt = db.prepare('UPDATE time_entries SET status = ? WHERE id = ?');
  const approvalStmt = db.prepare(`
    INSERT INTO approvals (time_entry_id, approver_id, status, comment)
    VALUES (?, ?, ?, ?)
  `);
  const notificationStmt = db.prepare(`
    INSERT INTO notifications (user_id, type, title, content, related_id)
    VALUES (?, ?, ?, ?, ?)
  `);

  const entryData = entry as any;
  const isOvertime = entryData.is_overtime === 1;

  const transaction = db.transaction(() => {
    updateStmt.run('rejected', timeEntryId);
    approvalStmt.run(timeEntryId, req.user!.userId, 'rejected', comment || null);
    
    const notificationType = isOvertime ? 'overtime_rejection' : 'rejection';
    const notificationTitle = isOvertime ? '加班申请被打回' : '工时被打回';
    const notificationContent = isOvertime 
      ? `您 ${entryData.entry_date} 的加班申请已被打回，原因：${comment || '无'}`
      : `您 ${entryData.entry_date} 的工时已被打回，原因：${comment || '无'}`;
    
    notificationStmt.run(
      entryData.user_id,
      notificationType,
      notificationTitle,
      notificationContent,
      timeEntryId
    );
  });

  try {
    transaction();
    res.json({ success: true, status: 'rejected', is_overtime: isOvertime });
  } catch (error) {
    res.status(500).json({ error: '操作失败' });
  }
});

router.post('/batch/approve', authenticateToken, requireRole('supervisor', 'admin'), (req, res) => {
  if (!req.user) return res.status(401).json({ error: '未认证' });

  const { userId, entryDate, comment } = req.body;

  const entries = db.prepare(`
    SELECT id, is_overtime FROM time_entries 
    WHERE user_id = ? AND entry_date = ? AND status = 'pending'
  `).all(userId, entryDate) as { id: number; is_overtime: number }[];

  if (entries.length === 0) {
    return res.status(400).json({ error: '没有待审批的记录' });
  }

  const hasOvertime = entries.some(e => e.is_overtime === 1);
  const hasNormal = entries.some(e => e.is_overtime === 0);

  const updateStmt = db.prepare('UPDATE time_entries SET status = ? WHERE id = ?');
  const approvalStmt = db.prepare(`
    INSERT INTO approvals (time_entry_id, approver_id, status, comment)
    VALUES (?, ?, ?, ?)
  `);
  const notificationStmt = db.prepare(`
    INSERT INTO notifications (user_id, type, title, content, related_id)
    VALUES (?, ?, ?, ?, ?)
  `);

  const transaction = db.transaction(() => {
    for (const entry of entries) {
      updateStmt.run('approved', entry.id);
      approvalStmt.run(entry.id, req.user!.userId, 'approved', comment || null);
    }
    
    if (hasOvertime) {
      notificationStmt.run(
        userId,
        'overtime_approval',
        '加班审批通过',
        `您 ${entryDate} 的加班申请已通过审批`,
        entries[0].id
      );
    }
    if (hasNormal) {
      notificationStmt.run(
        userId,
        'approval',
        '工时审批通过',
        `您 ${entryDate} 的工时已通过审批`,
        entries.find(e => e.is_overtime === 0)?.id || entries[0].id
      );
    }
  });

  try {
    transaction();
    res.json({ success: true, count: entries.length, has_overtime: hasOvertime });
  } catch (error) {
    res.status(500).json({ error: '批量审批失败' });
  }
});

router.post('/batch/reject', authenticateToken, requireRole('supervisor', 'admin'), (req, res) => {
  if (!req.user) return res.status(401).json({ error: '未认证' });

  const { userId, entryDate, comment } = req.body;

  const entries = db.prepare(`
    SELECT id, is_overtime FROM time_entries 
    WHERE user_id = ? AND entry_date = ? AND status = 'pending'
  `).all(userId, entryDate) as { id: number; is_overtime: number }[];

  if (entries.length === 0) {
    return res.status(400).json({ error: '没有待审批的记录' });
  }

  const hasOvertime = entries.some(e => e.is_overtime === 1);
  const hasNormal = entries.some(e => e.is_overtime === 0);

  const updateStmt = db.prepare('UPDATE time_entries SET status = ? WHERE id = ?');
  const approvalStmt = db.prepare(`
    INSERT INTO approvals (time_entry_id, approver_id, status, comment)
    VALUES (?, ?, ?, ?)
  `);
  const notificationStmt = db.prepare(`
    INSERT INTO notifications (user_id, type, title, content, related_id)
    VALUES (?, ?, ?, ?, ?)
  `);

  const transaction = db.transaction(() => {
    for (const entry of entries) {
      updateStmt.run('rejected', entry.id);
      approvalStmt.run(entry.id, req.user!.userId, 'rejected', comment || null);
    }
    
    if (hasOvertime) {
      notificationStmt.run(
        userId,
        'overtime_rejection',
        '加班申请被打回',
        `您 ${entryDate} 的加班申请已被打回，原因：${comment || '无'}`,
        entries[0].id
      );
    }
    if (hasNormal) {
      notificationStmt.run(
        userId,
        'rejection',
        '工时被打回',
        `您 ${entryDate} 的工时已被打回，原因：${comment || '无'}`,
        entries.find(e => e.is_overtime === 0)?.id || entries[0].id
      );
    }
  });

  try {
    transaction();
    res.json({ success: true, count: entries.length, has_overtime: hasOvertime });
  } catch (error) {
    res.status(500).json({ error: '操作失败' });
  }
});

export default router;

import { Router } from 'express';
import db from '../database';
import { authenticateToken } from '../middleware/auth';
import { TimeEntry, TimeEntryWithUser } from '../types';

const router = Router();

const getWeekRange = (dateStr: string): { startOfWeek: string; endOfWeek: string } => {
  const date = new Date(dateStr);
  const day = date.getDay();
  const diff = date.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(date);
  monday.setDate(diff);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  const format = (d: Date) => d.toISOString().split('T')[0];
  return { startOfWeek: format(monday), endOfWeek: format(sunday) };
};

const calculateWeeklyHours = (userId: number, startOfWeek: string, endOfWeek: string, excludeDate?: string): number => {
  let sql = `
    SELECT COALESCE(SUM(hours), 0) as total_hours
    FROM time_entries
    WHERE user_id = ?
      AND entry_date >= ?
      AND entry_date <= ?
      AND status != 'rejected'
  `;
  const params: any[] = [userId, startOfWeek, endOfWeek];
  if (excludeDate) {
    sql += ' AND entry_date != ?';
    params.push(excludeDate);
  }
  const result = db.prepare(sql).get(...params) as { total_hours: number };
  return result.total_hours;
};

const updateOvertimeStatusForWeek = (userId: number, startOfWeek: string, endOfWeek: string) => {
  const entries = db.prepare(`
    SELECT id, entry_date, hours, is_overtime
    FROM time_entries
    WHERE user_id = ?
      AND entry_date >= ?
      AND entry_date <= ?
      AND status != 'rejected'
    ORDER BY entry_date ASC, id ASC
  `).all(userId, startOfWeek, endOfWeek) as { id: number; entry_date: string; hours: number; is_overtime: number }[];

  const WEEKLY_STANDARD_HOURS = 40;
  let cumulativeHours = 0;
  let overtimeStartDate: string | null = null;

  for (const entry of entries) {
    if (overtimeStartDate) {
      db.prepare('UPDATE time_entries SET is_overtime = 1 WHERE id = ?').run(entry.id);
    } else {
      cumulativeHours += entry.hours;
      if (cumulativeHours > WEEKLY_STANDARD_HOURS) {
        overtimeStartDate = entry.entry_date;
        db.prepare('UPDATE time_entries SET is_overtime = 1 WHERE id = ?').run(entry.id);
      } else {
        db.prepare('UPDATE time_entries SET is_overtime = 0 WHERE id = ?').run(entry.id);
      }
    }
  }

  return { overtimeStartDate, totalHours: cumulativeHours };
};

router.get('/', authenticateToken, (req, res) => {
  if (!req.user) return res.status(401).json({ error: '未认证' });

  const { startDate, endDate, status, userId } = req.query;
  let sql = `
    SELECT te.*, p.name as project_name, u.name as user_name, u.department
    FROM time_entries te
    LEFT JOIN projects p ON te.project_id = p.id
    LEFT JOIN users u ON te.user_id = u.id
    WHERE 1=1
  `;
  const params: any[] = [];

  if (req.user.role === 'employee' || !userId) {
    sql += ' AND te.user_id = ?';
    params.push(req.user.userId);
  } else if (userId && userId !== 'all') {
    sql += ' AND te.user_id = ?';
    params.push(userId);
  }

  if (startDate) {
    sql += ' AND te.entry_date >= ?';
    params.push(startDate);
  }
  if (endDate) {
    sql += ' AND te.entry_date <= ?';
    params.push(endDate);
  }
  if (status) {
    sql += ' AND te.status = ?';
    params.push(status);
  }

  sql += ' ORDER BY te.entry_date DESC, te.created_at DESC';

  const entries = db.prepare(sql).all(...params) as TimeEntryWithUser[];
  res.json(entries);
});

router.get('/calendar', authenticateToken, (req, res) => {
  if (!req.user) return res.status(401).json({ error: '未认证' });

  const { month, year, userId } = req.query;
  const targetUserId = userId && req.user.role !== 'employee' ? Number(userId) : req.user.userId;

  const sql = `
    SELECT entry_date, 
           SUM(hours) as total_hours,
           SUM(CASE WHEN is_overtime = 1 THEN hours ELSE 0 END) as overtime_hours,
           COUNT(*) as entry_count,
           MAX(status) as status
    FROM time_entries
    WHERE user_id = ?
      AND strftime('%Y', entry_date) = ?
      AND strftime('%m', entry_date) = ?
    GROUP BY entry_date
    ORDER BY entry_date
  `;

  const data = db.prepare(sql).all(targetUserId, String(year), String(month).padStart(2, '0'));
  res.json(data);
});

router.post('/', authenticateToken, (req, res) => {
  if (!req.user) return res.status(401).json({ error: '未认证' });

  const { entries } = req.body;

  if (!entries || !Array.isArray(entries) || entries.length === 0) {
    return res.status(400).json({ error: '请至少填写一条工时记录' });
  }

  const entryDate = entries[0].entry_date;
  if (!entryDate) {
    return res.status(400).json({ error: '请选择日期' });
  }

  const totalHours = entries.reduce((sum: number, e: any) => sum + Number(e.hours || 0), 0);
  const { startOfWeek, endOfWeek } = getWeekRange(entryDate);

  const insertStmt = db.prepare(`
    INSERT INTO time_entries (user_id, entry_date, task_name, hours, project_id, description, is_overtime, status)
    VALUES (?, ?, ?, ?, ?, ?, 0, 'pending')
  `);

  const deleteStmt = db.prepare(`
    DELETE FROM time_entries 
    WHERE user_id = ? AND entry_date = ? AND status IN ('pending', 'rejected')
  `);

  const transaction = db.transaction(() => {
    deleteStmt.run(req.user!.userId, entryDate);

    const insertedIds: number[] = [];
    for (const entry of entries) {
      const result = insertStmt.run(
        req.user!.userId,
        entryDate,
        entry.task_name,
        Number(entry.hours),
        entry.project_id || null,
        entry.description || null
      );
      insertedIds.push(result.lastInsertRowid as number);
    }

    const { totalHours: weekTotalHours, overtimeStartDate } = updateOvertimeStatusForWeek(
      req.user!.userId,
      startOfWeek,
      endOfWeek
    );

    const user = db.prepare('SELECT supervisor_id, name FROM users WHERE id = ?').get(req.user!.userId) as { supervisor_id: number; name: string };
    if (overtimeStartDate && user.supervisor_id) {
      const notificationStmt = db.prepare(`
        INSERT INTO notifications (user_id, type, title, content, related_id)
        VALUES (?, 'overtime_pending', ?, ?, ?)
      `);
      notificationStmt.run(
        user.supervisor_id,
        '加班申请待审批',
        `${user.name} ${startOfWeek} 至 ${endOfWeek} 的周工时已超过40小时，产生加班申请，请审批`,
        insertedIds[0]
      );
    }

    return { insertedIds, weekTotalHours, overtimeStartDate };
  });

  try {
    const { insertedIds, weekTotalHours, overtimeStartDate } = transaction();
    const savedEntries = db.prepare(`
      SELECT te.*, p.name as project_name
      FROM time_entries te
      LEFT JOIN projects p ON te.project_id = p.id
      WHERE te.id IN (${insertedIds.map(() => '?').join(',')})
    `).all(...insertedIds) as TimeEntry[];

    const hasOvertime = savedEntries.some(e => e.is_overtime === 1);

    res.json({ 
      entries: savedEntries, 
      totalHours, 
      isOvertime: hasOvertime,
      weekTotalHours,
      weeklyStandardHours: 40,
      overtimeStartDate
    });
  } catch (error) {
    console.error('Save time entries error:', error);
    res.status(500).json({ error: '保存失败，请重试' });
  }
});

router.put('/:id', authenticateToken, (req, res) => {
  if (!req.user) return res.status(401).json({ error: '未认证' });

  const { id } = req.params;
  const { task_name, hours, project_id, description } = req.body;

  const existing = db.prepare('SELECT * FROM time_entries WHERE id = ?').get(id) as TimeEntry;
  if (!existing) {
    return res.status(404).json({ error: '记录不存在' });
  }

  if (existing.user_id !== req.user.userId && req.user.role === 'employee') {
    return res.status(403).json({ error: '只能修改自己的记录' });
  }

  if (existing.status === 'approved') {
    return res.status(400).json({ error: '已通过的记录不能修改' });
  }

  const { startOfWeek, endOfWeek } = getWeekRange(existing.entry_date);

  const stmt = db.prepare(`
    UPDATE time_entries 
    SET task_name = ?, hours = ?, project_id = ?, description = ?, status = 'pending', updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);

  const transaction = db.transaction(() => {
    stmt.run(task_name, Number(hours), project_id || null, description || null, id);
    updateOvertimeStatusForWeek(existing.user_id, startOfWeek, endOfWeek);
  });

  try {
    transaction();
  } catch (error) {
    console.error('Update time entry error:', error);
    return res.status(500).json({ error: '更新失败，请重试' });
  }

  const updated = db.prepare(`
    SELECT te.*, p.name as project_name
    FROM time_entries te
    LEFT JOIN projects p ON te.project_id = p.id
    WHERE te.id = ?
  `).get(id) as TimeEntry;

  res.json(updated);
});

router.delete('/:id', authenticateToken, (req, res) => {
  if (!req.user) return res.status(401).json({ error: '未认证' });

  const { id } = req.params;
  const existing = db.prepare('SELECT * FROM time_entries WHERE id = ?').get(id) as TimeEntry;

  if (!existing) {
    return res.status(404).json({ error: '记录不存在' });
  }

  if (existing.user_id !== req.user.userId && req.user.role === 'employee') {
    return res.status(403).json({ error: '只能删除自己的记录' });
  }

  if (existing.status === 'approved') {
    return res.status(400).json({ error: '已通过的记录不能删除' });
  }

  const { startOfWeek, endOfWeek } = getWeekRange(existing.entry_date);

  const transaction = db.transaction(() => {
    db.prepare('DELETE FROM time_entries WHERE id = ?').run(id);
    updateOvertimeStatusForWeek(existing.user_id, startOfWeek, endOfWeek);
  });

  try {
    transaction();
    res.json({ success: true });
  } catch (error) {
    console.error('Delete time entry error:', error);
    res.status(500).json({ error: '删除失败，请重试' });
  }
});

export default router;

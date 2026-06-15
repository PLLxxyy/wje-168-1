import { useState, useEffect, useCallback } from 'react';
import { Card, Input, DatePicker, Tag, Button, Table, Modal, message, Space, Tabs } from 'antd';
import { CheckCircle, XCircle, Search, ChevronDown, ChevronUp, Clock, Zap } from 'lucide-react';
import dayjs from 'dayjs';
import type { Dayjs } from 'dayjs';
import { getPendingApprovals, getPendingWeeklyApprovals, approveEntry, rejectEntry, batchApprove, batchReject } from '../api/approvals';
import type { PendingGroup, TimeEntry, WeeklyApprovalGroup } from '../types';

const { RangePicker } = DatePicker;

type ApprovalType = 'all' | 'normal' | 'overtime';
type ViewMode = 'daily' | 'weekly';

export default function ApprovalList() {
  const [dailyGroups, setDailyGroups] = useState<PendingGroup[]>([]);
  const [weeklyGroups, setWeeklyGroups] = useState<WeeklyApprovalGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchName, setSearchName] = useState('');
  const [dateRange, setDateRange] = useState<[Dayjs, Dayjs] | null>(null);
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());
  const [approvalType, setApprovalType] = useState<ApprovalType>('all');
  const [viewMode, setViewMode] = useState<ViewMode>('daily');
  const [rejectModal, setRejectModal] = useState<{
    visible: boolean;
    entryId: number | null;
    isBatch: boolean;
    userId?: number;
    entryDate?: string;
  }>({
    visible: false,
    entryId: null,
    isBatch: false,
  });
  const [rejectReason, setRejectReason] = useState('');

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      if (viewMode === 'daily') {
        const data = await getPendingApprovals(approvalType);
        setDailyGroups(data);
      } else {
        const data = await getPendingWeeklyApprovals(approvalType);
        setWeeklyGroups(data);
      }
    } catch {
      message.error('获取审批列表失败');
    } finally {
      setLoading(false);
    }
  }, [approvalType, viewMode]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const toggleExpand = (key: string) => {
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const handleApprove = async (id: number) => {
    try {
      const res = await approveEntry(id);
      if (res.is_overtime) {
        message.success('加班申请已通过');
      } else {
        message.success('已通过');
      }
      fetchData();
    } catch {
      message.error('操作失败');
    }
  };

  const handleRejectClick = (entryId: number) => {
    setRejectModal({ visible: true, entryId, isBatch: false });
    setRejectReason('');
  };

  const handleBatchRejectClick = (userId: number, entryDate: string) => {
    setRejectModal({ visible: true, entryId: null, isBatch: true, userId, entryDate });
    setRejectReason('');
  };

  const handleRejectConfirm = async () => {
    if (!rejectReason.trim()) {
      message.warning('请填写打回理由');
      return;
    }
    try {
      if (rejectModal.isBatch && rejectModal.userId && rejectModal.entryDate) {
        const res = await batchReject(rejectModal.userId, rejectModal.entryDate, rejectReason);
        if (res.has_overtime) {
          message.success('已全部打回（含加班申请）');
        } else {
          message.success('已全部打回');
        }
      } else if (rejectModal.entryId) {
        const res = await rejectEntry(rejectModal.entryId, rejectReason);
        if (res.is_overtime) {
          message.success('加班申请已打回');
        } else {
          message.success('已打回');
        }
      }
      setRejectModal({ visible: false, entryId: null, isBatch: false });
      fetchData();
    } catch {
      message.error('操作失败');
    }
  };

  const handleBatchApprove = async (userId: number, entryDate: string) => {
    try {
      const res = await batchApprove(userId, entryDate);
      if (res.has_overtime) {
        message.success('已全部通过（含加班申请）');
      } else {
        message.success('已全部通过');
      }
      fetchData();
    } catch {
      message.error('操作失败');
    }
  };

  const filteredDailyGroups = dailyGroups.filter((g) => {
    if (searchName && !g.user_name.includes(searchName)) return false;
    if (dateRange) {
      const entryDate = dayjs(g.entry_date);
      if (entryDate.isBefore(dateRange[0], 'day') || entryDate.isAfter(dateRange[1], 'day')) return false;
    }
    return true;
  });

  const filteredWeeklyGroups = weeklyGroups.filter((g) => {
    if (searchName && !g.user_name.includes(searchName)) return false;
    if (dateRange) {
      const weekStart = dayjs(g.week_start);
      const weekEnd = dayjs(g.week_start).add(6, 'day');
      if (weekEnd.isBefore(dateRange[0], 'day') || weekStart.isAfter(dateRange[1], 'day')) return false;
    }
    return true;
  });

  const renderEntries = (entries: TimeEntry[]) => {
    const columns = [
      { title: '任务名称', dataIndex: 'task_name', key: 'task_name' },
      { title: '工时(h)', dataIndex: 'hours', key: 'hours', width: 80 },
      { title: '项目', dataIndex: 'project_name', key: 'project_name', render: (v: string) => v || '-' },
      { title: '描述', dataIndex: 'description', key: 'description', render: (v: string) => v || '-', ellipsis: true },
      {
        title: '类型',
        key: 'type',
        width: 80,
        render: (_: unknown, record: TimeEntry) => (
          record.is_overtime === 1 ? <Tag color="orange">加班</Tag> : <Tag color="green">正常</Tag>
        ),
      },
      {
        title: '操作',
        key: 'action',
        width: 160,
        render: (_: unknown, record: TimeEntry) => (
          <Space>
            <Button type="link" size="small" icon={<CheckCircle size={14} />} onClick={() => handleApprove(record.id)}>
              通过
            </Button>
            <Button type="link" size="small" danger icon={<XCircle size={14} />} onClick={() => handleRejectClick(record.id)}>
              打回
            </Button>
          </Space>
        ),
      },
    ];
    return <Table columns={columns} dataSource={entries} rowKey="id" pagination={false} size="small" />;
  };

  const tabItems = [
    { key: 'all', label: '全部' },
    { key: 'normal', label: '正常工时' },
    { key: 'overtime', label: <span><Zap size={14} className="inline mr-1" />加班申请</span> },
  ];

  const renderDailyView = () => (
    <div className="space-y-3">
      {filteredDailyGroups.map((group) => {
        const key = `${group.user_id}_${group.entry_date}`;
        const expanded = expandedKeys.has(key);
        const hasOvertime = group.is_overtime === 1;
        return (
          <Card key={key} size="small" className={`shadow-sm ${hasOvertime ? 'border-l-4 border-l-orange-400' : ''}`}>
            <div
              className="flex items-center justify-between cursor-pointer"
              onClick={() => toggleExpand(key)}
            >
              <div className="flex items-center gap-4">
                <span className="font-medium">{group.user_name}</span>
                <span className="text-gray-500">{group.department}</span>
                <span className="text-gray-400">{group.entry_date}</span>
                <span>总工时: {group.total_hours.toFixed(1)}h</span>
                {hasOvertime && <Tag color="orange">含加班</Tag>}
              </div>
              <div className="flex items-center gap-2">
                <Button
                  type="primary"
                  size="small"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleBatchApprove(group.user_id, group.entry_date);
                  }}
                >
                  全部通过
                </Button>
                <Button
                  danger
                  size="small"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleBatchRejectClick(group.user_id, group.entry_date);
                  }}
                >
                  全部打回
                </Button>
                {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
              </div>
            </div>
            {expanded && <div className="mt-3">{renderEntries(group.entries)}</div>}
          </Card>
        );
      })}
    </div>
  );

  const renderWeeklyView = () => (
    <div className="space-y-4">
      {filteredWeeklyGroups.map((group) => {
        const key = `week_${group.user_id}_${group.week_start}`;
        const expanded = expandedKeys.has(key);
        const weekEnd = dayjs(group.week_start).add(6, 'day').format('YYYY-MM-DD');
        return (
          <Card key={key} size="small" className={`shadow-sm ${group.has_overtime ? 'border-l-4 border-l-orange-400' : ''}`}>
            <div
              className="flex items-center justify-between cursor-pointer"
              onClick={() => toggleExpand(key)}
            >
              <div className="flex items-center gap-4">
                <span className="font-medium">{group.user_name}</span>
                <span className="text-gray-500">{group.department}</span>
                <span className="text-gray-400">
                  {group.week_start} ~ {weekEnd}
                </span>
                <span>周总工时: <strong>{group.total_hours.toFixed(1)}h</strong></span>
                {group.has_overtime && (
                  <Tag color="orange">
                    加班 {group.overtime_hours.toFixed(1)}h
                  </Tag>
                )}
              </div>
              <div className="flex items-center gap-3">
                <div className="text-sm text-gray-500">
                  正常: {group.normal_hours.toFixed(1)}h
                  {group.has_overtime && (
                    <span className="text-orange-500 ml-2">加班: {group.overtime_hours.toFixed(1)}h</span>
                  )}
                </div>
                {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
              </div>
            </div>
            {expanded && (
              <div className="mt-3 space-y-3">
                {group.daily_groups.map((daily) => {
                  const dayKey = `${key}_${daily.entry_date}`;
                  const dayExpanded = expandedKeys.has(dayKey);
                  return (
                    <div key={dayKey} className="bg-gray-50 rounded p-3">
                      <div
                        className="flex items-center justify-between cursor-pointer"
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleExpand(dayKey);
                        }}
                      >
                        <div className="flex items-center gap-3">
                          <Clock className="w-4 h-4 text-gray-400" />
                          <span className="font-medium">{daily.entry_date}</span>
                          <span className="text-sm text-gray-500">{daily.total_hours.toFixed(1)}h</span>
                          {daily.is_overtime === 1 && <Tag color="orange" size="small">加班</Tag>}
                        </div>
                        <div className="flex items-center gap-2">
                          <Button
                            type="primary"
                            size="small"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleBatchApprove(group.user_id, daily.entry_date);
                            }}
                          >
                            全部通过
                          </Button>
                          <Button
                            danger
                            size="small"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleBatchRejectClick(group.user_id, daily.entry_date);
                            }}
                          >
                            全部打回
                          </Button>
                          {dayExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                        </div>
                      </div>
                      {dayExpanded && <div className="mt-2">{renderEntries(daily.entries)}</div>}
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
        );
      })}
    </div>
  );

  const hasData = viewMode === 'daily' ? filteredDailyGroups.length > 0 : filteredWeeklyGroups.length > 0;

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-bold">审批管理</h1>
        <Space>
          <RangePicker value={dateRange} onChange={(v) => setDateRange(v as [Dayjs, Dayjs] | null)} />
          <Input
            placeholder="搜索员工姓名"
            prefix={<Search size={14} />}
            value={searchName}
            onChange={(e) => setSearchName(e.target.value)}
            allowClear
            style={{ width: 200 }}
          />
        </Space>
      </div>

      <Card size="small" className="mb-4 shadow-sm">
        <div className="flex items-center justify-between">
          <Tabs
            activeKey={approvalType}
            onChange={(key) => setApprovalType(key as ApprovalType)}
            items={tabItems}
            size="small"
          />
          <Space>
            <Button
              type={viewMode === 'daily' ? 'primary' : 'default'}
              size="small"
              onClick={() => setViewMode('daily')}
            >
              按日查看
            </Button>
            <Button
              type={viewMode === 'weekly' ? 'primary' : 'default'}
              size="small"
              onClick={() => setViewMode('weekly')}
            >
              按周查看
            </Button>
          </Space>
        </div>
      </Card>

      {loading ? (
        <div className="text-center text-gray-400 py-12">加载中...</div>
      ) : hasData ? (
        viewMode === 'daily' ? renderDailyView() : renderWeeklyView()
      ) : (
        <div className="text-center text-gray-400 py-12">暂无待审批记录</div>
      )}

      <Modal
        title="打回理由"
        open={rejectModal.visible}
        onOk={handleRejectConfirm}
        onCancel={() => setRejectModal({ visible: false, entryId: null, isBatch: false })}
        okText="确认打回"
        cancelText="取消"
      >
        <Input.TextArea
          rows={4}
          value={rejectReason}
          onChange={(e) => setRejectReason(e.target.value)}
          placeholder="请输入打回理由（必填）"
        />
      </Modal>
    </div>
  );
}

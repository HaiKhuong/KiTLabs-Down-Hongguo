import { t, useLanguage, getLanguage } from '../i18n';
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import useDialogKeyboard from './useDialogKeyboard';
import './DownloadManager.css';
import { Download, Trash2, RefreshCw, X, Film, Square, Folder, Zap, CheckSquare, Play, Pause, Layers, Settings, Info, AlertTriangle, Search, LayoutGrid, List, ChevronDown, ChevronUp, ChevronLeft, ChevronRight } from './icons';

const STATUS_TEXT = {
  pending: '等待中',
  downloading: '下载中',
  completed: '已完成',
  failed: '失败',
  stopped: '已停止',
};

const STATUS_ORDER = {
  downloading: 0,
  pending: 1,
  failed: 2,
  stopped: 3,
  completed: 4,
};

const isWaitingRetry = task => task.status === 'failed' && !!task.retryAt;
const needsManualRetry = task => task.status === 'stopped' || task.status === 'failed' && !isWaitingRetry(task);
const seriesKey = task => task.hongguoInfo?.series_id != null ? `series:${task.hongguoInfo.series_id}` : `task:${task.id}`;
const seriesLabel = task => task.hongguoInfo?.series_title || task.title || task.filename || '';

function sortTasks(list) {
  const key = seriesKey;
  const groups = new Map();
  for (const task of list) {
    const group = groups.get(key(task)) || { rank: 99, time: 0 };
    group.rank = Math.min(group.rank, STATUS_ORDER[task.status] ?? 99);
    group.time = Math.max(group.time, task.startTime || 0);
    groups.set(key(task), group);
  }
  return [...list].sort((a, b) => {
    const ka = key(a), kb = key(b), ga = groups.get(ka), gb = groups.get(kb);
    if (ka !== kb) return ga.rank - gb.rank || gb.time - ga.time || ka.localeCompare(kb, 'zh-CN', { numeric: true });
    return (Number(a.hongguoInfo?.vid_index) || 0) - (Number(b.hongguoInfo?.vid_index) || 0) || (a.startTime || 0) - (b.startTime || 0);
  });
}

function fmtElapsed(seconds) {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  return value < 60 ? `${value} 秒` : value < 3600 ? `${Math.floor(value / 60)} 分 ${value % 60} 秒` : `${Math.floor(value / 3600)} 小时 ${Math.floor(value % 3600 / 60)} 分`;
}

function fmtBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return v.toFixed(v >= 100 || i === 0 ? 0 : 1) + ' ' + units[i];
}

const PAGE_SIZE = 100;
const GROUP_PAGE_SIZE = 20;

function DownloadManager({ onNavigate, active = true }) {
  useLanguage();
  const [tasks, setTasks] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [toast, setToast] = useState(null);
  const [queue, setQueue] = useState({ active: 0, queued: 0, maxConcurrent: 3 });
  const [seriesList, setSeriesList] = useState([]);
  const [mergeSeriesId, setMergeSeriesId] = useState('');
  const [merging, setMerging] = useState(false);
  const [mergeError, setMergeError] = useState('');
  const [mergeTasks, setMergeTasks] = useState([]);
  const [confirmAsk, setConfirmAsk] = useState(null); // 删除确认（可勾选删除本地文件）
  const [mergeAsk, setMergeAsk] = useState(false);    // 合并格式选择
  const [page, setPage] = useState(1);
  const [seriesFilter, setSeriesFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('all'); // 'all' | 'active' | 'completed' | 'failed'
  const [searchQuery, setSearchQuery] = useState('');
  const [groupMode, setGroupMode] = useState('grouped'); // 'grouped' | 'list'
  const [expandedGroups, setExpandedGroups] = useState(new Set());
  const autoExpandedRef = useRef(false);
  const [groupPages, setGroupPages] = useState({});
  const [groupPageInputs, setGroupPageInputs] = useState({});
  const [policyOpen, setPolicyOpen] = useState(false);
  const [errorDetailTask, setErrorDetailTask] = useState(null);
  const [orderVersion, setOrderVersion] = useState(0);
  const [loadError, setLoadError] = useState('');
  const toastTimerRef = useRef(null);
  const moreActionsRef = useRef(null);
  const mergeRequestRef = useRef(false);
  const mergeDialogGenerationRef = useRef(0);
  const activeRef = useRef(active);
  activeRef.current = active;
  const requests = useRef({ tasks: 0, queue: 0, series: 0, merges: 0 });
  const taskIndex = useRef(new Map());
  const downloadedSeries = useRef(new Set());

  useEffect(() => {
    const menu = moreActionsRef.current;
    const close = () => { if (menu) menu.open = false; };
    if (!active) { close(); return; }
    const outside = event => { if (!menu?.contains(event.target)) close(); };
    const escape = event => {
      if (event.key !== 'Escape' || !menu?.open) return;
      event.preventDefault(); event.stopPropagation();
      close(); menu.querySelector('summary')?.focus();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    document.addEventListener('keydown', escape);
    window.addEventListener('blur', close);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
      document.removeEventListener('keydown', escape);
      window.removeEventListener('blur', close);
    };
  }, [active]);

  const refresh = useCallback(async () => {
    const request = ++requests.current.tasks;
    try {
      const list = await window.electronAPI.getDownloadTasks();
      if (!activeRef.current || request !== requests.current.tasks) return;
      if (!Array.isArray(list)) throw new Error('下载任务读取失败，请重试');
      for (const task of list) if (task.status === 'completed' && task.hongguoInfo?.series_id) downloadedSeries.current.add(String(task.hongguoInfo.series_id));
      setTasks(list);
      setOrderVersion(value => value + 1);
      const ids = new Set(list.map(task => task.id));
      setSelected(previous => new Set([...previous].filter(id => ids.has(id))));
      setLoadError('');
    } catch (error) {
      if (activeRef.current && request === requests.current.tasks) setLoadError(error.message || '下载任务读取失败，请重试');
    }
  }, []);

  const loadQueue = useCallback(async () => {
    const request = ++requests.current.queue;
    try {
      const q = await window.electronAPI.getQueueStatus();
      if (q && activeRef.current && request === requests.current.queue) setQueue(q);
    } catch (_) {}
  }, []);

  const loadSeriesList = useCallback(async (verifyFiles = true) => {
    const request = ++requests.current.series;
    try {
      let list = (await window.electronAPI.getSeriesList(verifyFiles ? { downloadedOnly: true } : undefined)) || [];
      if (!activeRef.current || request !== requests.current.series) return;
      if (verifyFiles) downloadedSeries.current = new Set(list.map(series => String(series.series_id)));
      else list = list.filter(series => downloadedSeries.current.has(String(series.series_id)));
      setSeriesList(list);
      setMergeSeriesId((prev) => list.some(item => String(item.series_id) === prev) ? prev : (list[0] ? String(list[0].series_id) : ''));
    } catch (_) {}
  }, []);

  // 列表刷新改选另一部剧时，旧确认框不能继续提交。
  useEffect(() => {
    mergeDialogGenerationRef.current += 1;
    setMergeAsk(false);
    setMergeError('');
  }, [mergeSeriesId]);

  const loadMergeTasks = useCallback(async () => {
    const request = ++requests.current.merges;
    try {
      const list = (await window.electronAPI.getMergeTasks()) || [];
      if (activeRef.current && request === requests.current.merges) setMergeTasks(list);
    } catch (_) {}
  }, []);

  const showToast = useCallback((text, type = 'success') => {
    setToast({ text, type });
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 3200);
  }, []);

  useEffect(() => () => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
  }, []);

  useEffect(() => {
    if (!active) return;
    refresh();
    loadQueue();
    loadSeriesList();
    loadMergeTasks();
    const patches = new Map();
    let batchTimer = null, fullRefresh = false, reorder = false, seriesDirty = false, queueDirty = false;
    const schedule = () => {
      if (batchTimer !== null) return;
      batchTimer = setTimeout(() => {
        batchTimer = null;
        if (fullRefresh) refresh();
        else if (patches.size) {
          const updates = new Map(patches);
          setTasks(previous => previous.map(task => updates.has(task.id) ? { ...task, ...updates.get(task.id) } : task));
          if (reorder) setOrderVersion(value => value + 1);
        }
        if (seriesDirty) loadSeriesList(false);
        if (queueDirty) loadQueue();
        patches.clear();
        fullRefresh = reorder = seriesDirty = queueDirty = false;
      }, 200);
    };
    const patchTask = (data, status, affectsOrder = false) => {
      if (!data?.id) return;
      patches.set(data.id, { ...patches.get(data.id), ...data, status });
      reorder ||= affectsOrder || taskIndex.current.get(data.id)?.status !== status;
      schedule();
    };
    const cleanups = [
      window.electronAPI.onDownloadProgress((data) => {
        patchTask(data, 'downloading');
      }),
      window.electronAPI.onDownloadTaskAdded(() => { fullRefresh = seriesDirty = true; schedule(); }),
      window.electronAPI.onDownloadCompleted((data) => {
        const sid = data?.hongguoInfo?.series_id ?? taskIndex.current.get(data?.id)?.hongguoInfo?.series_id;
        if (sid) downloadedSeries.current.add(String(sid));
        seriesDirty = true;
        patchTask({ ...data, progress: 100 }, 'completed', true);
      }),
      window.electronAPI.onDownloadFailed((data) => {
        patchTask(data, 'failed', true);
      }),
      window.electronAPI.onDownloadStopped((data) => {
        patchTask(data, 'stopped', true);
      }),
      window.electronAPI.onDownloadQueueChanged(() => {
        fullRefresh = queueDirty = seriesDirty = true;
        schedule();
      }),
      window.electronAPI.onMergeTaskAdded(() => loadMergeTasks()),
      window.electronAPI.onMergeProgress((data) => {
        setMergeTasks((prev) =>
          prev.map((t) => (t.id === data.id ? { ...t, ...data } : t))
        );
      }),
      window.electronAPI.onMergeCompleted((data) => {
        loadMergeTasks();
        showToast(data.storageWarning || ('合并完成：' + (data.path ? data.path.split(/[\\/]/).pop() : '')), data.storageWarning ? 'error' : 'success');
      }),
      window.electronAPI.onMergeFailed((data) => {
        loadMergeTasks();
        showToast('合并失败：' + (data.error || '未知错误'), 'error');
      }),
    ];
    const timer = setInterval(() => {
      loadQueue();
      refresh();
      loadMergeTasks();
    }, 15000);
    return () => {
      cleanups.forEach(cleanup => cleanup());
      clearInterval(timer);
      clearTimeout(batchTimer);
      for (const key of Object.keys(requests.current)) requests.current[key]++;
    };
  }, [active, refresh, loadQueue, loadSeriesList, loadMergeTasks, showToast]);

  const toggleSelect = (id) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const clearSelection = () => setSelected(new Set());

  const fmtSize = (b) => {
    if (!b || b <= 0) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let v = b;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return v.toFixed(v >= 100 || i === 0 ? 0 : 1) + ' ' + u[i];
  };

  /** 弹删除确认：默认只删记录，可勾选同时删除本地文件 */
  const askDelete = (list, label) => {
    const items = (list || []).filter(Boolean);
    if (!items.length) return;
    // 用已下载字节数估算可释放空间（完成任务才有意义）
    const estBytes = items.reduce((s, t) => s + (t.totalBytes || t.receivedBytes || 0), 0);
    const withFile = items.filter((t) => t.status === 'completed').length;
    setConfirmAsk({
      title: label,
      count: items.length,
      withFile,
      estBytes,
      onOk: async (deleteFiles) => {
        try {
          const ids = items.map((t) => t.id);
          const res = await window.electronAPI.deleteTasksWithFiles(ids, deleteFiles);
          await Promise.all([refresh(), loadSeriesList()]);
          if (!res?.success) {
            const progress = Number.isFinite(res?.count) && Number.isFinite(res?.freed)
              ? `已移除 ${res.count} 个任务记录，已释放 ${fmtSize(res.freed)}；` : '';
            throw new Error(progress + (res?.error || '删除失败，请重试'));
          }
          showToast(deleteFiles
            ? `已删除 ${res.count} 个任务，释放 ${fmtSize(res.freed)}`
            : `已删除 ${res.count} 个任务记录（本地文件已保留）`);
        } catch (error) { showToast(error.message || '删除失败，请重试', 'error'); }
      },
    });
  };

  const deleteSelected = async () => {
    if (selected.size === 0) return;
    askDelete(tasks.filter((t) => selected.has(t.id)), '删除选中任务');
  };
  const retrySelected = async () => {
    if (selected.size === 0) return;
    const res = await window.electronAPI.retryTasks(Array.from(selected));
    setSelected(new Set());
    await refresh();
    if (res && res.success) {
      showToast(res.count > 0 ? `已重新加入队列：${res.count} 项` : '选中项中没有可重试的任务');
    } else {
      showToast((res && res.error) || '重试失败', 'error');
    }
  };

  // 一键合并选中的短剧
  const openMergeDialog = () => {
    mergeDialogGenerationRef.current += 1;
    setMergeError('');
    setMergeAsk(true);
  };

  const closeMergeDialog = () => {
    mergeDialogGenerationRef.current += 1;
    setMergeError('');
    setMergeAsk(false);
  };

  const doMerge = async (compatible, require1080 = false) => {
    if (mergeRequestRef.current) return;
    if (!mergeSeriesId) {
      showToast('请先选择要合并的短剧', 'error');
      return;
    }
    mergeRequestRef.current = true;
    const dialogGeneration = mergeDialogGenerationRef.current;
    setMerging(true);
    setMergeError('');
    try {
      const options = require1080 ? { compatible: false, require1080: true } : { compatible };
      const res = await window.electronAPI.mergeSeries(mergeSeriesId, '', options);
      if (dialogGeneration !== mergeDialogGenerationRef.current) return;
      if (!res || !res.success) {
        setMergeError((res && res.error) || '合并失败');
        return;
      }
      closeMergeDialog();
      await loadMergeTasks();
      const sizeGb = (res.totalBytes / 1073741824).toFixed(2);
      const duration = res.totalDuration > 0 ? ` / ${fmtElapsed(res.totalDuration)}` : ' / 时长待探测';
      showToast(compatible
        ? `开始兼容格式合并 ${res.count} 集（H.264，耗时较长）`
        : require1080
        ? `开始高质量分辨率合并 ${res.count} 集`
        : `开始合并 ${res.count} 集（约 ${sizeGb} GB${duration}）`);
      if (res.codecWarning) showToast(res.codecWarning, 'error');
    } catch (e) {
      if (dialogGeneration === mergeDialogGenerationRef.current) setMergeError('合并异常: ' + e.message);
    } finally {
      mergeRequestRef.current = false;
      setMerging(false);
    }
  };

  const cancelMerge = async (id) => {
    try {
      const result = await window.electronAPI.cancelMerge(id);
      if (!result?.success) throw new Error(result?.error || '取消请求失败，请重试');
      showToast('取消请求已发送，正在等待合并停止。');
      await loadMergeTasks();
    } catch (error) { showToast(error.message || '取消请求失败，请重试', 'error'); }
  };

  const openMergedFile = async (path) => {
    if (!path) return;
    try {
      const result = await window.electronAPI.showInFolder(path);
      if (!result?.success) throw new Error(result?.error || '无法打开文件夹');
    } catch (error) { showToast(error.message || '无法打开文件夹', 'error'); }
  };

  const openTaskFolder = async (id) => {
    try {
      const result = await window.electronAPI.openFolder(id);
      if (!result?.success) throw new Error(result?.error || '无法打开文件夹');
    } catch (error) { showToast(error.message || '无法打开文件夹', 'error'); }
  };

  // 一键暂停：取消进行中的 + 清空等待队列
  const pauseAll = async () => {
    try {
      const res = await window.electronAPI.pauseAll();
      await refresh();
      await loadQueue();
      showToast(res?.success ? `已暂停 ${res.count} 个任务` : (res?.error || '暂停失败'), res?.success ? 'success' : 'error');
    } catch (error) { showToast(error.message || '暂停失败', 'error'); }
  };

  // 一键启动：把所有已停止/失败/等待中的任务重新排队开跑
  const resumeAll = async () => {
    try {
      const res = await window.electronAPI.resumeAll();
      await refresh();
      await loadQueue();
      showToast(res?.success ? `已启动 ${res.count} 个任务` : (res?.error || '启动失败'), res?.success ? 'success' : 'error');
    } catch (error) { showToast(error.message || '启动失败', 'error'); }
  };

  // 重试失败/已停止的任务
  const retryAllFailed = async () => {
    const ids = scopedTasks.filter(needsManualRetry).map((t) => t.id);
    if (ids.length === 0) return;
    const res = await window.electronAPI.retryTasks(ids);
    await refresh();
    if (res && res.success) {
      showToast(`已重新加入队列：${res.count} 项`);
    } else {
      showToast((res && res.error) || '重试失败', 'error');
    }
  };

  // 一键选中全部失败/已停止的任务（选中后可再点「重试选中」）
  const selectAllFailed = () => {
    const ids = scopedTasks.filter(needsManualRetry).map((t) => t.id);
    if (ids.length === 0) {
      showToast('没有失败或已停止的任务');
      return;
    }
    setSelected(new Set(ids));
    showToast(`已选中 ${ids.length} 项，可点「重试选中」重新下载`);
  };

  const clearCompleted = async () => {
    const done = scopedTasks.filter((t) => t.status === 'completed');
    if (done.length === 0) return;
    askDelete(done, '清空已完成任务');
  };

  // Progress updates change row values, not the established series/episode order.
  const sortedIds = useMemo(() => sortTasks(tasks).map(task => task.id), [orderVersion]);
  const taskById = useMemo(() => new Map(tasks.map(task => [task.id, task])), [tasks]);
  taskIndex.current = taskById;
  const seriesOptions = useMemo(() => {
    const groups = new Map();
    for (const task of tasks) {
      const key = seriesKey(task);
      const group = groups.get(key) || { key, label:seriesLabel(task), count:0, waiting:0, failed:0 };
      group.count++;
      if (isWaitingRetry(task)) group.waiting++;
      if (needsManualRetry(task)) group.failed++;
      groups.set(key, group);
    }
    return [...groups.values()].sort((a, b) =>
      a.label.localeCompare(b.label, 'zh-CN', { numeric:true }));
  }, [tasks]);
  const activeFilter = seriesOptions.some(option => option.key === seriesFilter) ? seriesFilter : '';
  const scopedTasks = useMemo(() => activeFilter
    ? tasks.filter(task => seriesKey(task) === activeFilter) : tasks, [tasks, activeFilter]);
  const scopedIds = useMemo(() => activeFilter
    ? sortedIds.filter(id => seriesKey(taskById.get(id)) === activeFilter) : sortedIds,
  [sortedIds, taskById, activeFilter]);
  const allSelected = scopedTasks.length > 0 && scopedTasks.every(task => selected.has(task.id));
  const selectAll = () => setSelected(new Set(scopedTasks.map(task => task.id)));
  const pageCount = Math.max(1, Math.ceil(scopedIds.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const visibleTasks = scopedIds.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE).map(id => taskById.get(id)).filter(Boolean);

  const activeCount = scopedTasks.filter((t) => t.status === 'downloading' || t.status === 'pending').length;
  const completedCount = scopedTasks.filter((t) => t.status === 'completed').length;
  const retryingCount = scopedTasks.filter(isWaitingRetry).length;
  const failedTasks = useMemo(
    () => scopedTasks.filter(needsManualRetry),
    [scopedTasks]
  );
  const failedCount = failedTasks.length;

  // 与主进程 pauseAllTasks 一致；按钮始终控制所有剧，不受当前筛选影响。
  const pausableCount = useMemo(
    () => tasks.filter((t) => ['pending', 'downloading'].includes(t.status) || t.status === 'failed' && t.retryAt).length,
    [tasks]
  );

  // 已选中项里真正可重试的数量
  const retryableSelectedCount = useMemo(
    () =>
      Array.from(selected).filter((id) => {
        const t = taskById.get(id);
        return t && (t.status === 'failed' || t.status === 'stopped');
      }).length,
    [selected, taskById]
  );

  useDialogKeyboard(active && !!(confirmAsk || mergeAsk || policyOpen || errorDetailTask), () => {
    setConfirmAsk(null);
    closeMergeDialog();
    setPolicyOpen(false);
    setErrorDetailTask(null);
  }, '.dm-container .player-confirm');

  const filteredIds = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return scopedIds.filter((id) => {
      const task = taskById.get(id);
      if (!task) return false;
      if (statusFilter === 'active' && !['downloading', 'pending'].includes(task.status) && !isWaitingRetry(task)) return false;
      if (statusFilter === 'completed' && task.status !== 'completed') return false;
      if (statusFilter === 'failed' && !needsManualRetry(task)) return false;
      if (q) {
        const hay = `${seriesLabel(task)} ${task.title || ''} ${task.filename || ''} ${task.hongguoInfo?.vid_index || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [scopedIds, taskById, statusFilter, searchQuery]);

  const dramaGroups = useMemo(() => {
    const map = new Map();
    for (const id of filteredIds) {
      const task = taskById.get(id);
      if (!task) continue;
      const key = seriesKey(task);
      let group = map.get(key);
      if (!group) {
        group = {
          key,
          seriesId: task.hongguoInfo?.series_id ? String(task.hongguoInfo.series_id) : '',
          title: seriesLabel(task),
          cover: task.videoInfo?.cover || '',
          tasks: [],
          completed: 0,
          failed: 0,
          active: 0,
          retrying: 0,
        };
        map.set(key, group);
      }
      if (!group.cover && task.videoInfo?.cover) group.cover = task.videoInfo.cover;
      group.tasks.push(task);
      if (task.status === 'completed') group.completed++;
      else if (needsManualRetry(task)) group.failed++;
      else if (isWaitingRetry(task)) group.retrying++;
      else if (task.status === 'downloading' || task.status === 'pending') group.active++;
    }
    return [...map.values()];
  }, [filteredIds, taskById]);

  useEffect(() => {
    if (!autoExpandedRef.current && dramaGroups.length > 0) {
      autoExpandedRef.current = true;
      setExpandedGroups(new Set([dramaGroups[0].key]));
    }
  }, [dramaGroups]);

  const toggleGroupExpand = (key) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const retryTaskIds = async (ids) => {
    if (!ids.length) return;
    try {
      const res = await window.electronAPI.retryTasks(ids);
      await refresh();
      if (res?.success) showToast(res.count > 0 ? `已重新加入队列：${res.count} 项` : '选中项中没有可重试的任务');
      else showToast(res?.error || '重试失败', 'error');
    } catch (error) { showToast(error.message || '重试失败', 'error'); }
  };

  const listPageCount = Math.max(1, Math.ceil(filteredIds.length / PAGE_SIZE));
  const listPage = Math.min(page, listPageCount);
  const visibleListTasks = filteredIds.slice((listPage - 1) * PAGE_SIZE, listPage * PAGE_SIZE).map(id => taskById.get(id)).filter(Boolean);

  return (
    <div className="dm-container">
      {/* 4. Downloads Header */}
      <header className="dm-page-header">
        <div className="dm-page-header-left">
          <div className="dm-header-icon"><Download size={22} /></div>
          <div>
            <h2>{t("下载管理")}</h2>
            <p>{t("搜索剧名或粘贴分享链接，选择想保存的集数。")}</p>
          </div>
        </div>
        <div className="dm-page-header-right">
          <div className="dm-stats">
            <button type="button" className={`stat stat-active ${statusFilter === 'active' ? 'is-active' : ''}`}
              aria-pressed={statusFilter === 'active'} onClick={() => setStatusFilter(s => s === 'active' ? 'all' : 'active')}>
              {t("进行中 ")}{activeCount}
            </button>
            {retryingCount > 0 && <span className="stat stat-active">{t("等待重试 ")}{retryingCount}</span>}
            <button type="button" className={`stat stat-done ${statusFilter === 'completed' ? 'is-active' : ''}`}
              aria-pressed={statusFilter === 'completed'} onClick={() => setStatusFilter(s => s === 'completed' ? 'all' : 'completed')}>
              {t("已完成 ")}{completedCount}
            </button>
            <button type="button" className={`stat stat-fail ${statusFilter === 'failed' ? 'is-active' : ''}`}
              aria-pressed={statusFilter === 'failed'} onClick={() => setStatusFilter(s => s === 'failed' ? 'all' : 'failed')}>
              {t("失败/停止 ")}{failedCount}
            </button>
          </div>
          <button type="button" className="btn btn-outline btn-sm" onClick={() => setPolicyOpen(true)}>
            <Info size={14} /><span>{t("下载风险与使用倡议")}</span>
          </button>
          {onNavigate && (
            <button type="button" className="btn btn-outline btn-sm" onClick={() => onNavigate('settings')}>
              <Settings size={14} /><span>{t("设置")}</span>
            </button>
          )}
          {onNavigate && (
            <button type="button" className="btn btn-primary btn-sm" onClick={() => onNavigate('download')}>
              <Film size={15} /><span>{t("添加下载")}</span>
            </button>
          )}
        </div>
      </header>

      {/* 6. Global Download Toolbar */}
      <div className="dm-global-toolbar">
        <div className="dm-toolbar-left">
          <button
            className="btn btn-primary btn-sm"
            onClick={resumeAll}
            disabled={!tasks.some(task => ['stopped', 'failed', 'pending'].includes(task.status))}
            title={t("全部开始：把所有剧中等待中 / 已停止 / 失败的任务排队开跑")}
          >
            <Play size={14} /><span>{t("全部开始")}</span>
          </button>
          <button
            className="btn btn-outline btn-sm"
            onClick={pauseAll}
            disabled={pausableCount === 0}
            title={t("全部暂停：暂停所有剧中正在下载、等待中及等待自动重试的任务")}
          >
            <Pause size={14} /><span>{t("全部暂停")}</span>
          </button>
          <button
            className="btn btn-outline btn-sm"
            onClick={retryAllFailed}
            disabled={failedCount === 0}
            title={t("把所有失败/已停止的任务一次性重新加入下载队列")}
          >
            <RefreshCw size={14} /><span>{t(failedCount > 0 ? `重试失败 (${failedCount})` : '重试失败')}</span>
          </button>
          <details className="dm-more-actions" ref={moreActionsRef}>
            <summary>{t("更多操作")}</summary>
            <div className="dm-more-menu" onClick={event => { const button = event.target.closest('button'); if (button && !button.disabled) moreActionsRef.current.open = false; }}>
              <button className="btn btn-outline" onClick={selectAllFailed} disabled={failedCount === 0}>
                <CheckSquare size={14} /><span>{t(failedCount > 0 ? `选中失败项 (${failedCount})` : '选中失败项')}</span>
              </button>
              <button className="btn btn-outline" onClick={retrySelected} disabled={retryableSelectedCount === 0}>
                <RefreshCw size={14} /><span>{t("重试选中 (")}{retryableSelectedCount})</span>
              </button>
              <button className="btn btn-outline" onClick={clearCompleted} disabled={completedCount === 0}>
                <X size={14} /><span>{t("清空已完成")}</span>
              </button>
              <button className="btn btn-outline" onClick={clearSelection} disabled={selected.size === 0}>
                <span>{t("取消选择")}</span>
              </button>
              <button className="btn btn-outline" onClick={async () => {
                const r = await window.electronAPI.rescanDownloads();
                await refresh();
                await loadSeriesList();
                showToast(r && r.success
                  ? (r.count > 0 ? `已从磁盘补回 ${r.count} 条下载记录` : '没有发现未登记的文件')
                  : '扫描失败');
              }}>
                <RefreshCw size={14} /><span>{t("扫描下载目录")}</span>
              </button>
            </div>
          </details>
        </div>

        <div className="dm-toolbar-right">
          <div className="dm-search-wrap">
            <Search size={14} />
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => { setSearchQuery(e.target.value); setPage(1); }}
              placeholder={t("搜索剧名…")}
              aria-label={t("搜索剧名…")}
            />
          </div>
          <div className="browse-view-toggle" role="group" aria-label="View mode">
            <button type="button" className={groupMode === 'grouped' ? 'active' : ''} onClick={() => setGroupMode('grouped')} title="Grouped view" aria-label="Grouped view">
              <LayoutGrid size={14} />
            </button>
            <button type="button" className={groupMode === 'list' ? 'active' : ''} onClick={() => setGroupMode('list')} title="List view" aria-label="List view">
              <List size={14} />
            </button>
          </div>
          {seriesOptions.length > 0 && (
            <select
              id="dm-series-select"
              className="dm-series-select"
              value={activeFilter}
              aria-label={t("按剧集查看")}
              onChange={(event) => {
                setSeriesFilter(event.target.value);
                setSelected(new Set());
                setPage(1);
              }}
            >
              <option value="">{t("全部剧集（{0} 项）", [tasks.length])}</option>
              {seriesOptions.map(option => (
                <option key={option.key} value={option.key}>
                  {option.label} ({option.count})
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      {/* Active Queue Banner */}
      {queue.active > 0 && (
        <div className="dm-queue-bar">
          <span className="dm-queue-running">
            <span className="dm-queue-pulse" />{t("正在并发下载 ")}<b>{t(queue.active)}</b> / {t(queue.maxConcurrent)}
            {queue.queued > 0 ? <>{t(" · 队列等待 ")}<b>{t(queue.queued)}</b></> : null}
          </span>
          <span className="dm-queue-hint">{t("并发数可在「设置 → 最大并发下载数」调整")}</span>
        </div>
      )}

      {/* Contextual Bulk Action Bar (List view only) */}
      {groupMode === 'list' && selected.size > 0 && (
        <div className="dm-bulk-bar dm-bulk-bar-right" role="region" aria-label={t("更多操作")}>
          <span className="dm-bulk-count">{t("已选 ")}{selected.size}{t(" 项")}</span>
          <div className="dm-bulk-actions">
            {retryableSelectedCount > 0 && (
              <button type="button" className="btn btn-primary btn-sm" onClick={retrySelected}>
                <RefreshCw size={13} /><span>{t("重试选中 (")}{retryableSelectedCount})</span>
              </button>
            )}
            <button type="button" className="btn btn-outline btn-sm" onClick={deleteSelected}>
              <Trash2 size={13} /><span>{t("删除已选（")}{selected.size}{t("项）")}</span>
            </button>
            <button type="button" className="btn btn-outline btn-sm" onClick={clearSelection}>
              <span>{t("取消选择")}</span>
            </button>
          </div>
        </div>
      )}

      {/* Merge Tasks Progress */}
      {mergeTasks.length > 0 && (
        <div className="merge-list">
          {mergeTasks.map((m) => (
            <div key={m.id} className={`merge-card merge-${m.status}`}>
              <Layers size={16} />
              <div className="merge-body">
                <div className="merge-title">{t("合并《")}{m.seriesTitle}》· {m.done || 0}/{t(m.total)}{t(" 集")}</div>
                <div className="merge-sub">
                  {m.status === 'running' && <>{t(m.stageText || '正在合并')}{t(m.method && m.method !== m.stageText ? ` · ${m.method}` : '')}</>}
                  {m.status === 'completed' && (
                    <>{t("已完成 · ")}{m.outputName}
                      {t(m.outputBytes ? ` · ${fmtBytes(m.outputBytes)}` : '')}
                    </>
                  )}
                  {m.status === 'failed' && <>{t("失败：")}{t(m.error)}</>}
                  {m.status === 'stopped' && <>{t(m.error || '已取消')}</>}
                </div>
                <div className="merge-metrics">
                  <span>{t(m.stage === 'checking' ? `已检查 ${m.checked || 0}` : `已处理 ${m.done || 0}`)} / {t(m.total)}{t(" 集")}</span>
                  <span>{t("用时 ")}{t(fmtElapsed(m.status === 'running' ? (Date.now() - m.startTime) / 1000 : m.elapsedSeconds || ((m.endTime || m.startTime) - m.startTime) / 1000))}</span>
                  {m.status === 'running' && m.speed > 0 && <span>{t(m.speed.toFixed(1))}{t(" 倍速")}</span>}
                  {m.status === 'running' && Number.isFinite(m.etaSeconds) && <span>{t("本阶段约剩 ")}{t(fmtElapsed(m.etaSeconds))}</span>}
                </div>
                {(m.codecWarning || m.storageWarning || m.cleanupWarning) && <div className="merge-note">{t(m.storageWarning || m.cleanupWarning || m.codecWarning)}</div>}
                {(m.status === 'running') && (
                  <div className="dm-progress">
                    <div className="dm-progress-bar" role="progressbar" aria-label={t("合并进度")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={m.progress || 0}>
                      <div className="dm-progress-fill" style={{ width: `${m.progress || 0}%` }} />
                    </div>
                    <span className="dm-pct">{m.progress || 0}%</span>
                  </div>
                )}
              </div>
              <div className="merge-actions">
                {m.status === 'running' && (
                  <button className="icon-btn" title={t("取消合并")} onClick={() => cancelMerge(m.id)}>
                    <X size={16} />
                  </button>
                )}
                {m.status === 'completed' && (
                  <button className="icon-btn" title={t("打开所在文件夹")} onClick={() => openMergedFile(m.output)}>
                    <Folder size={16} />
                  </button>
                )}
                {m.status !== 'running' && (
                  <button
                    className="icon-btn icon-btn-danger"
                    title={t("移除记录")}
                    onClick={async () => {
                      try {
                        const result = await window.electronAPI.deleteMergeTask(m.id);
                        if (!result?.success) throw new Error(result?.error || '移除记录失败');
                        await loadMergeTasks();
                      } catch (error) { showToast(error.message || '移除记录失败，请重试', 'error'); }
                    }}
                  >
                    <Trash2 size={16} />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {loadError && <div className="alert alert-error" role="alert">{t(loadError)}<button className="btn btn-outline btn-sm" onClick={refresh}>{t("重新加载")}</button></div>}

      {/* Empty / No Results / Grouped & List Content */}
      {tasks.length === 0 ? (
        <div className="dm-empty">
          <Download size={40} />
          <p>{t("暂无下载任务")}</p>
          <p className="dm-empty-sub">{t("搜索剧名或粘贴分享链接，选择想保存的集数。")}</p>
          {onNavigate && <button className="btn btn-primary" onClick={() => onNavigate('download')}>{t("添加第一部短剧")}</button>}
        </div>
      ) : filteredIds.length === 0 ? (
        <div className="dm-empty">
          <Search size={36} />
          <p>{t("没有找到相关短剧")}</p>
          <button type="button" className="btn btn-outline btn-sm" onClick={() => { setStatusFilter('all'); setSearchQuery(''); setSeriesFilter(''); }}>
            {t("恢复默认")}
          </button>
        </div>
      ) : groupMode === 'grouped' ? (
        <div className="dm-groups-list">
          {dramaGroups.map((group) => {
            const isExpanded = expandedGroups.has(group.key);
            const total = group.tasks.length;
            const pct = total > 0 ? Math.round((group.completed / total) * 1000) / 10 : 0;
            const groupRetryIds = group.tasks.filter(needsManualRetry).map(item => item.id);
            const groupResumableIds = group.tasks.filter(item => ['stopped', 'failed'].includes(item.status)).map(item => item.id);
            const firstTask = group.tasks[0];
            const gPages = Math.max(1, Math.ceil(total / GROUP_PAGE_SIZE));
            const gPage = Math.min(groupPages[group.key] || 1, gPages);
            const visibleGroupTasks = group.tasks.slice((gPage - 1) * GROUP_PAGE_SIZE, gPage * GROUP_PAGE_SIZE);
            const groupAllSelected = total > 0 && group.tasks.every(item => selected.has(item.id));
            const groupSelectedTasks = group.tasks.filter(item => selected.has(item.id));
            const groupSelectedCount = groupSelectedTasks.length;
            const groupRetryableSelectedIds = groupSelectedTasks.filter(needsManualRetry).map(item => item.id);
            const canMergeGroup = group.seriesId && seriesList.some(s => String(s.series_id) === group.seriesId);

            return (
              <section className={`dm-drama-card ${isExpanded ? 'is-expanded' : ''}`} key={group.key}>
                {/* 7 & 11. Drama Card Header */}
                <div className="dm-drama-header" onClick={() => toggleGroupExpand(group.key)}>
                  <div className="dm-drama-poster">
                    {group.cover ? <img src={group.cover} alt={group.title} loading="lazy" /> : <div className="cover-placeholder"><Film size={20} /></div>}
                  </div>
                  <div className="dm-drama-info">
                    <h3 className="dm-drama-title">《{group.title}》</h3>
                    <div className="dm-drama-stats-row">
                      <span>{t("{0} 集", [total])}</span>
                      <span className="is-success">{t("已完成 ")}{group.completed}</span>
                      {group.active > 0 && <span className="is-info">{t("进行中 ")}{group.active}</span>}
                      {group.failed > 0 && <span className="is-danger">{t("失败/停止 ")}{group.failed}</span>}
                    </div>
                    <div className="dm-drama-progress-row">
                      <div className="dm-drama-progress-track">
                        <div className="dm-drama-progress-fill" style={{ width: `${pct}%` }} />
                      </div>
                      <span className="dm-drama-progress-pct">{pct.toFixed(1)}%</span>
                    </div>
                  </div>
                  <div className="dm-drama-header-right" onClick={(e) => e.stopPropagation()}>
                    <div className="dm-drama-actions">
                      {groupResumableIds.length > 0 && (
                        <button type="button" className="btn btn-primary btn-sm" onClick={() => retryTaskIds(groupResumableIds)} title={t("全部开始")}>
                          <Play size={13} /><span>{t("全部开始")}</span>
                        </button>
                      )}
                      {groupRetryIds.length > 0 && (
                        <button type="button" className="btn btn-outline btn-sm" onClick={() => retryTaskIds(groupRetryIds)} title={t("重试失败")}>
                          <RefreshCw size={13} /><span>{t("重试")}</span>
                        </button>
                      )}
                      {canMergeGroup && (
                        <button type="button" className="btn btn-outline btn-sm" onClick={() => { setMergeSeriesId(group.seriesId); setTimeout(openMergeDialog, 0); }} disabled={merging} title={t("合并整部剧")}>
                          <Layers size={13} /><span>{t("合并整部剧")}</span>
                        </button>
                      )}
                      {firstTask && (
                        <button type="button" className="icon-btn" onClick={() => openTaskFolder(firstTask.id)} title={t("打开文件夹")} aria-label={t("打开文件夹")}>
                          <Folder size={15} />
                        </button>
                      )}
                      <button type="button" className="icon-btn dm-expand-btn" onClick={() => toggleGroupExpand(group.key)}
                        aria-expanded={isExpanded} title={t(isExpanded ? '折叠组' : '展开组')} aria-label={t(isExpanded ? '折叠组' : '展开组')}>
                        {isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                      </button>
                    </div>
                    {groupSelectedCount > 0 && (
                      <div className="dm-bulk-bar dm-drama-bulk" role="region" aria-label={t("更多操作")}>
                        <span className="dm-bulk-count">{t("已选 ")}{groupSelectedCount}{t(" 项")}</span>
                        <div className="dm-bulk-actions">
                          {groupRetryableSelectedIds.length > 0 && (
                            <button type="button" className="btn btn-primary btn-sm" onClick={() => retryTaskIds(groupRetryableSelectedIds)}>
                              <RefreshCw size={12} /><span>{t("重试选中 (")}{groupRetryableSelectedIds.length})</span>
                            </button>
                          )}
                          <button type="button" className="btn btn-outline btn-sm" onClick={() => askDelete(groupSelectedTasks, `删除所选 ${groupSelectedCount} 项`)}>
                            <Trash2 size={12} /><span>{t("删除已选（")}{groupSelectedCount}{t("项）")}</span>
                          </button>
                          <button type="button" className="btn btn-outline btn-sm" onClick={() => {
                            setSelected((prev) => {
                              const next = new Set(prev);
                              groupSelectedTasks.forEach(item => next.delete(item.id));
                              return next;
                            });
                          }}>
                            <span>{t("取消选择")}</span>
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                {/* 8. Expandable Episode Table */}
                {isExpanded && (
                  <div className="dm-table-wrap">
                    <div className="dm-table-scroll">
                      <table className="dm-ep-table">
                      <thead>
                        <tr>
                          <th className="col-check">
                            <input type="checkbox" checked={groupAllSelected} aria-label={t("全选")}
                              onChange={() => {
                                setSelected((prev) => {
                                  const next = new Set(prev);
                                  if (groupAllSelected) group.tasks.forEach(item => next.delete(item.id));
                                  else group.tasks.forEach(item => next.add(item.id));
                                  return next;
                                });
                              }} />
                          </th>
                          <th>{t("集数")}</th>
                          <th>{t("当前")}</th>
                          <th>{t("进度")}</th>
                          <th className="col-size">{t("本地已占用")}</th>
                          <th className="col-actions">{t("更多操作")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {visibleGroupTasks.map((task) => {
                          const isSel = selected.has(task.id);
                          const waitingRetry = isWaitingRetry(task);
                          const canStop = task.status === 'downloading' || task.status === 'pending' || waitingRetry;
                          const canRetry = task.status === 'failed' || task.status === 'stopped';
                          const pctVal = task.status === 'completed' ? 100 : (task.progress || 0);
                          const epLabel = task.hongguoInfo?.vid_index != null
                            ? t("第 {0} 集", [String(task.hongguoInfo.vid_index).padStart(3, '0')])
                            : (task.title || task.filename);
                          const sizeBytes = task.totalBytes || task.receivedBytes || 0;
                          const statusClass = waitingRetry ? 'retrying' : task.status;

                          return (
                            <tr key={task.id} className={isSel ? 'is-selected' : ''} onClick={() => toggleSelect(task.id)}>
                              <td className="col-check" onClick={(e) => e.stopPropagation()}>
                                <input type="checkbox" checked={isSel} aria-label={epLabel} onChange={() => toggleSelect(task.id)} />
                              </td>
                              <td>
                                <div className="dm-ep-cell">
                                  <Film size={14} className="dm-ep-icon" />
                                  <span className="dm-ep-name">{epLabel}</span>
                                </div>
                              </td>
                              <td>
                                <div className="dm-status-cell">
                                  <span className={`dm-status-badge status-${statusClass}`}>
                                    {t(waitingRetry ? '等待重试' : STATUS_TEXT[task.status] || task.status)}
                                  </span>
                                  {['failed', 'stopped'].includes(task.status) && task.error && (
                                    <button type="button" className="dm-err-link" title={task.error}
                                      onClick={(e) => { e.stopPropagation(); setErrorDetailTask(task); }}>
                                      {t(task.error)}
                                    </button>
                                  )}
                                  {['downloading', 'completed'].includes(task.status) && task.qualityNotice && (
                                    <span className="dm-quality-note">{t(task.qualityNotice)}</span>
                                  )}
                                </div>
                              </td>
                              <td>
                                {task.status === 'completed' || task.status === 'downloading' || task.status === 'pending' ? (
                                  <div className="dm-row-progress">
                                    <div className="dm-row-progress-track">
                                      <div className={`dm-row-progress-fill is-${statusClass}`} style={{ width: `${pctVal}%` }} />
                                    </div>
                                    <span>{pctVal}%</span>
                                  </div>
                                ) : (
                                  <span className="dm-muted">—</span>
                                )}
                              </td>
                              <td className="col-size">
                                <span className="dm-size-text">{sizeBytes > 0 ? fmtBytes(sizeBytes) : '—'}</span>
                              </td>
                              <td className="col-actions" onClick={(e) => e.stopPropagation()}>
                                <div className="dm-row-actions">
                                  {canStop && (
                                    <button type="button" className="icon-btn" title={t(waitingRetry ? '停止自动重试' : '停止')} onClick={async () => {
                                      try {
                                        const result = await window.electronAPI.stopDownload(task.id);
                                        if (!result?.success) throw new Error(result?.error || '停止失败');
                                        await refresh();
                                      } catch (error) { showToast(error.message || '停止失败', 'error'); }
                                    }}><Square size={14} /></button>
                                  )}
                                  {canRetry && (
                                    <button type="button" className="icon-btn" title={t('重试')} onClick={async () => {
                                      try {
                                        const result = await window.electronAPI.retryTask(task.id);
                                        if (!result?.success) throw new Error(result?.error || '重试失败');
                                      } catch (error) { showToast(error.message || '重试失败', 'error'); }
                                    }}><RefreshCw size={14} /></button>
                                  )}
                                  <button type="button" className="icon-btn" title={t("打开文件夹")} onClick={() => openTaskFolder(task.id)}>
                                    <Folder size={14} />
                                  </button>
                                  <button type="button" className="icon-btn icon-btn-danger" title={t("删除")}
                                    onClick={() => askDelete([task], `删除《${group.title}》第 ${task.hongguoInfo ? task.hongguoInfo.vid_index : ''} 集任务`)}>
                                    <Trash2 size={14} />
                                  </button>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                      </table>
                    </div>

                    {/* 10. Table Footer & Pagination */}
                    <div className="dm-table-footer">
                      <div className="dm-table-footer-left">
                        <label className="dm-footer-check">
                          <input type="checkbox" checked={groupAllSelected} onChange={() => {
                            setSelected((prev) => {
                              const next = new Set(prev);
                              if (groupAllSelected) group.tasks.forEach(item => next.delete(item.id));
                              else group.tasks.forEach(item => next.add(item.id));
                              return next;
                            });
                          }} />
                          <span>{t("全选")} ({total})</span>
                        </label>
                        {groupSelectedCount > 0 && <span className="dm-footer-selected">{t("已选 ")}{groupSelectedCount}</span>}
                      </div>
                      {gPages > 1 && (
                        <div className="dm-table-pager">
                          <button type="button" className="pager-item" disabled={gPage <= 1} onClick={() => setGroupPages(p => ({ ...p, [group.key]: gPage - 1 }))}>
                            <ChevronLeft size={13} />
                          </button>
                          <span className="dm-pager-text">{gPage} / {gPages}</span>
                          <button type="button" className="pager-item" disabled={gPage >= gPages} onClick={() => setGroupPages(p => ({ ...p, [group.key]: gPage + 1 }))}>
                            <ChevronRight size={13} />
                          </button>
                          <form className="dm-goto-form" onSubmit={(e) => {
                            e.preventDefault();
                            const n = Math.min(Math.max(1, Number(groupPageInputs[group.key]) || 1), gPages);
                            setGroupPages(p => ({ ...p, [group.key]: n }));
                          }}>
                            <input
                              type="number"
                              min={1}
                              max={gPages}
                              value={groupPageInputs[group.key] ?? ''}
                              onChange={(e) => setGroupPageInputs(p => ({ ...p, [group.key]: e.target.value }))}
                              placeholder={String(gPage)}
                              aria-label={t("页")}
                            />
                            <button type="submit" className="btn btn-outline btn-sm">{t("应用")}</button>
                          </form>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </section>
            );
          })}
        </div>
      ) : (
        /* Flat List View */
        <div className="dm-list-wrap">
          <div className="dm-list">
            {visibleListTasks.map((task) => {
              const isSel = selected.has(task.id);
              const waitingRetry = isWaitingRetry(task);
              const canStop = task.status === 'downloading' || task.status === 'pending' || waitingRetry;
              const canRetry = task.status === 'failed' || task.status === 'stopped';
              const pct = task.progress || 0;
              return (
                <div key={task.id} className={`dm-task ${isSel ? 'selected' : ''}`} onClick={() => toggleSelect(task.id)}>
                  <input className="dm-task-select" type="checkbox" aria-label={t(`选择 ${task.title || task.filename}`)} checked={isSel} onClick={(e) => e.stopPropagation()} onChange={() => toggleSelect(task.id)} />
                  <div className="dm-task-cover">
                    {task.videoInfo?.cover ? <img src={task.videoInfo.cover} alt="" /> : <div className="cover-placeholder"><Film size={18} /></div>}
                  </div>
                  <div className="dm-task-body">
                    <div className="dm-task-title">{task.title || task.filename}</div>
                    <div className="dm-task-meta">
                      <span className={`dm-status-badge status-${waitingRetry ? 'retrying' : task.status}`}>{t(waitingRetry ? '等待重试' : STATUS_TEXT[task.status] || task.status)}</span>
                      {['failed', 'stopped'].includes(task.status) && task.error && (
                        <button type="button" className="dm-err-link" onClick={(e) => { e.stopPropagation(); setErrorDetailTask(task); }}>{t(task.error)}</button>
                      )}
                    </div>
                    {(task.status === 'downloading' || task.status === 'pending') && (
                      <div className="dm-progress">
                        <div className="dm-progress-bar"><div className="dm-progress-fill" style={{ width: `${pct}%` }} /></div>
                        <span className="dm-pct">{pct}%</span>
                      </div>
                    )}
                  </div>
                  <div className="dm-task-actions" onClick={(e) => e.stopPropagation()}>
                    {canStop && (
                      <button className="icon-btn" title={t(waitingRetry ? '停止自动重试' : '停止')} onClick={async () => {
                        try {
                          const result = await window.electronAPI.stopDownload(task.id);
                          if (!result?.success) throw new Error(result?.error || '停止失败');
                          await refresh();
                        } catch (error) { showToast(error.message || '停止失败', 'error'); }
                      }}><Square size={15} /></button>
                    )}
                    {canRetry && (
                      <button className="icon-btn" title={t('重试')} onClick={async () => {
                        try {
                          const result = await window.electronAPI.retryTask(task.id);
                          if (!result?.success) throw new Error(result?.error || '重试失败');
                        } catch (error) { showToast(error.message || '重试失败', 'error'); }
                      }}><RefreshCw size={15} /></button>
                    )}
                    <button className="icon-btn" title={t("打开文件夹")} onClick={() => openTaskFolder(task.id)}><Folder size={15} /></button>
                    <button className="icon-btn icon-btn-danger" title={t("删除")} onClick={() => askDelete([task], `删除《${seriesLabel(task)}》`)}><Trash2 size={15} /></button>
                  </div>
                </div>
              );
            })}
          </div>
          {listPageCount > 1 && (
            <div className="dm-table-pager" style={{ justifyContent: 'center', marginTop: 12 }}>
              <button className="btn btn-outline btn-sm" disabled={listPage <= 1} onClick={() => setPage(listPage - 1)}>{t("上一页")}</button>
              <span className="dm-pager-text">{t("第 {0} / {1} 页", [listPage, listPageCount])}</span>
              <button className="btn btn-outline btn-sm" disabled={listPage >= listPageCount} onClick={() => setPage(listPage + 1)}>{t("下一页")}</button>
            </div>
          )}
        </div>
      )}

      {toast && (
        <div className={`dm-toast dm-toast-${toast.type}`} role={toast.type === 'error' ? 'alert' : 'status'} onClick={() => setToast(null)}>
          {toast.text}
        </div>
      )}

      {/* 12. Download Policy Dialog */}
      {policyOpen && (
        <div className="player-confirm-mask" onClick={() => setPolicyOpen(false)}>
          <div className="player-confirm" role="dialog" aria-modal="true" aria-label={t("下载风险与使用倡议")} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
            <div className="player-confirm-title"><Info size={17} /><span>{t("下载风险与使用倡议")}</span></div>
            <div className="player-confirm-msg">
              <p><strong>{t("临时故障会自动重试。")}</strong>{t("红果片源下载遇到断网、超时或传输不完整时，普通故障最多追加 3 次重试，分别等待 10、30、60 秒；注册拒绝或空响应最多追加 6 轮重试，分别等待 15、30、60、120、300、600 秒；来源暂不可用时等待 3、8、15 分钟。等待期间可停止或手动重试，但共享冷却可能让手动重试延后开始。权限限制、磁盘错误等需手动处理；重试后仍失败的任务会保留。")}</p>
              <p>{t("本软件用于学习研究，建议体验后 24 小时内自行删除；请勿冒充官方或以虚假授权名义收费。开源权利义务以 GPLv3 为准。上述倡议不代表获得平台或版权方授权，也不构成免责承诺。")}</p>
            </div>
            <div className="player-confirm-foot">
              <button className="btn btn-primary" onClick={() => setPolicyOpen(false)}>{t("关闭")}</button>
            </div>
          </div>
        </div>
      )}

      {/* 9. Error Details Dialog */}
      {errorDetailTask && (
        <div className="player-confirm-mask" onClick={() => setErrorDetailTask(null)}>
          <div className="player-confirm" role="dialog" aria-modal="true" aria-label={t("失败")} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
            <div className="player-confirm-title" style={{ color: 'var(--danger)' }}><AlertTriangle size={17} /><span>{errorDetailTask.title || errorDetailTask.filename}</span></div>
            <div className="player-confirm-msg">
              <p>{errorDetailTask.error}</p>
              {errorDetailTask.nasWarning && <p>{errorDetailTask.nasWarning}</p>}
              {errorDetailTask.metadataWarning && <p>{errorDetailTask.metadataWarning}</p>}
            </div>
            <div className="player-confirm-foot">
              <button className="btn btn-outline" onClick={() => setErrorDetailTask(null)}>{t("关闭")}</button>
              <button className="btn btn-primary" onClick={() => { const id = errorDetailTask.id; setErrorDetailTask(null); retryTaskIds([id]); }}>{t("重试")}</button>
            </div>
          </div>
        </div>
      )}

      {/* 合并格式选择 */}
      {mergeAsk && (
        <div className="player-confirm-mask" onClick={closeMergeDialog}>
          <div className="player-confirm" role="dialog" aria-modal="true" aria-label={t(confirmAsk ? confirmAsk.title : '合并导出')} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
            <div className="player-confirm-title" style={{ color: 'var(--accent)' }}>
              <Layers size={17} />{t("合并整部剧")}</div>
            <div className="player-confirm-msg">
              <p>{t("将《")}{(seriesList.find((series) => String(series.series_id) === mergeSeriesId)?.series_title || t('所选短剧'))}{t("》的全部已下载分集合并为一个 mp4。未下载的分集不会自动补齐。")}</p>
              <p><b>{t("高质量分辨率合并")}</b>{t("：逐集检查实际文件，全部达到1080P才能开始；有低清分集请选快速或兼容合并。")}</p>
              <p><b>{t("快速合并")}</b>{t("：优先无损拼接，保留每段原分辨率，部分设备可能不兼容。")}</p>
              <p><b>{t("兼容合并")}</b>{t("：必要时转为H.264/AAC，仍保留每段原分辨率，处理较慢。")}</p>
              <p>{t("三种方式都保留原文件，只合并已下载分集，不自动补齐，也不会把低清变成真高清。")}</p>
              {mergeError && <p className="alert-error" role="alert">{t(mergeError)}</p>}
            </div>
            <div className="player-confirm-foot">
              <button className="btn btn-outline" onClick={() => doMerge(false, true)} disabled={merging}>{t("高质量分辨率合并")}</button>
              <button className="btn btn-outline" onClick={closeMergeDialog}>{t("取消")}</button>
              <button className="btn btn-outline" onClick={() => doMerge(true)} disabled={merging}>{t("兼容合并（H.264）")}</button>
              <button className="btn btn-primary" onClick={() => doMerge(false)} disabled={merging}>{t("智能快速合并")}</button>
            </div>
          </div>
        </div>
      )}

      {/* 删除确认（可选是否连本地文件一起删） */}
      {confirmAsk && (
        <div className="player-confirm-mask" onClick={() => setConfirmAsk(null)}>
          <div className="player-confirm" role="dialog" aria-modal="true" aria-label={t(confirmAsk ? confirmAsk.title : '合并导出')} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
            <div className="player-confirm-title">
              <Trash2 size={17} />
              {confirmAsk.title}
            </div>
            <div className="player-confirm-msg">
              <p>{t("共 ")}{t(confirmAsk.count)}{t(" 个任务，其中 ")}{t(confirmAsk.withFile)}{t(" 个已下载完成")}{t(confirmAsk.estBytes > 0 ? `（约 ${fmtSize(confirmAsk.estBytes)}）` : '')}。</p>
              <label className="dm-confirm-check">
                <input
                  type="checkbox"
                  checked={!!confirmAsk._del}
                  onChange={(e) => setConfirmAsk({ ...confirmAsk, _del: e.target.checked })}
                />
                <span>{t("同时删除本地文件")}{t(confirmAsk.estBytes > 0 ? `（释放约 ${fmtSize(confirmAsk.estBytes)}）` : '')}
                </span>
              </label>
              <p className="dm-confirm-hint">{t("不勾选则只移除任务记录，磁盘上的视频文件会保留（可在文件管理器里自行管理）。")}</p>
            </div>
            <div className="player-confirm-foot">
              <button className="btn btn-outline" onClick={() => setConfirmAsk(null)}>{t("取消")}</button>
              <button
                className={`btn ${confirmAsk._del ? 'btn-danger-solid' : 'btn-primary'}`}
                onClick={async () => {
                  const fn = confirmAsk.onOk;
                  const del = !!confirmAsk._del;
                  setConfirmAsk(null);
                  await fn(del);
                }}
              >
                {t(confirmAsk._del ? '删除任务和文件' : '仅删除记录')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default DownloadManager;

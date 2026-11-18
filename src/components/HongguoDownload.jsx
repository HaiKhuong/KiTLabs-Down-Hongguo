import { t, useLanguage } from '../i18n';
import React, { useState, useRef, useEffect } from 'react';
import './HongguoDownload.css';
import { Film, Download, CheckSquare, Square, RefreshCw, Folder, Link2, Search, Play, Bell, X, Check } from './icons';
import SearchPanel from './SearchPanel';
import useMediaSources from './useMediaSources';
import { mediaSourceLabel } from './mediaSourcesModel.mjs';
import { isSubmitKey, parseEpisodeRange } from './episodeRange';


function HongguoDownload({ onNavigate, active = true }) {
  useLanguage();
  const mobile = window.electronAPI.platform === 'android';
  const { sources: mediaSources, revision: sourceRevision } = useMediaSources();
  const [tab, setTab] = useState('search'); // 'search' | 'input'
  const [inputUrl, setInputUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [successMsg, setSuccessMsg] = useState('');

  // 短剧解析结果
  const [seriesData, setSeriesData] = useState(null); // { series_id, series_title, cover, total, episodes: [...] }
  const [publicIntro, setPublicIntro] = useState(null);
  const [introExpanded, setIntroExpanded] = useState(false);
  const seriesDescription = [seriesData?.description, seriesData?.intro, seriesData?.series_intro]
    .find(value => typeof value === 'string' && value.trim())?.trim() || '';
  const description = seriesDescription || (publicIntro?.seriesId === seriesData?.series_id ? publicIntro?.description : '') || '';
  const [selectedVids, setSelectedVids] = useState(new Set());
  const [rangeInput, setRangeInput] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [exportKinds, setExportKinds] = useState({ danmaku: false, comments: false, reviews: false });
  const [exportNote, setExportNote] = useState('');
  const [exportSettingsNote, setExportSettingsNote] = useState('');
  const exportInitialized = useRef(false);
  const textExportRequest = useRef(null);
  const seriesIdRef = useRef(null);
  seriesIdRef.current = seriesData?.series_id;
  const [downloadQuality, setDownloadQuality] = useState('auto');
  const [downloadDir, setDownloadDir] = useState('');
  const [pendingCount, setPendingCount] = useState(0);
  const [externalQuery, setExternalQuery] = useState('');
  const [downloadToast, setDownloadToast] = useState(null);
  const toastTimer = useRef(null);
  const [qualityLoading, setQualityLoading] = useState(true);
  const [openingPlayer, setOpeningPlayer] = useState(false);
  const playPending = useRef(false);
  const firstPlayable = seriesData?.episodes.find((ep) => !ep.locked);
  // 评论/弹幕/剧评仅红果来源可取（取数函数都以纯数字 ID 为前置校验）；其它来源隐藏导出勾选。
  const isHongguoSource = /^\d{6,30}$/.test(String(seriesData?.series_id || ''));
  const resolveRequest = useRef(0);
  const pendingResolve = useRef(null);
  const searchVersion = resolveRequest.current;

  useEffect(() => {
    setIntroExpanded(false);
    setPublicIntro(null);
    if (!seriesData || seriesDescription || !/^\d{6,30}$/.test(String(seriesData.series_id))) return;
    let cancelled = false;
    const seriesId = seriesData.series_id;
    setPublicIntro({ seriesId, loading: true });
    Promise.resolve().then(() => window.electronAPI.getPublicDetails(seriesId)).then(data => {
      if (cancelled) return;
      const intro = data?.success && String(data.series_id) === String(seriesId) && typeof data.description === 'string' ? data.description.trim() : '';
      setPublicIntro({ seriesId, description: intro, loading: false, failed: !data?.success });
    }).catch(() => {
      if (!cancelled) setPublicIntro({ seriesId, loading: false, failed: true });
    });
    return () => { cancelled = true; };
  }, [seriesData, seriesDescription]);

  useEffect(() => () => { resolveRequest.current++; }, []);
  useEffect(() => { if (!active) { resolveRequest.current++; playPending.current = false; setLoading(false); pendingResolve.current = null; } }, [active]);
  useEffect(() => {
    resolveRequest.current++; pendingResolve.current = null; setLoading(false);
    setSeriesData(current => current?.series_id?.startsWith('custom:') ? null : current);
  }, [sourceRevision]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setQualityLoading(true);
    window.electronAPI.getSettings().then((settings) => {
      if (!cancelled) {
        setDownloadQuality(['1080p', '720p'].includes(settings?.download_quality) ? settings.download_quality : 'auto');
        setDownloadDir(settings?.download_dir || '');
      }
      if (!cancelled && !exportInitialized.current) {
        const et = settings?.export_text || {};
        setExportKinds({ danmaku: et.danmaku === true, comments: et.comments === true, reviews: et.reviews === true });
        exportInitialized.current = true;
      }
    }).catch(() => {
      if (!cancelled) setErrorMsg('默认下载清晰度读取失败，请确认清晰度后再下载');
    }).finally(() => { if (!cancelled) setQualityLoading(false); });
    window.electronAPI.getTasks?.().then((tasks) => {
      if (!cancelled && Array.isArray(tasks)) {
        setPendingCount(tasks.filter(task => ['queued', 'running', 'waiting'].includes(task.status)).length);
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [active]);

  useEffect(() => {
    const onQuickSearch = (event) => {
      const q = String(event?.detail?.query || '').trim();
      if (!q) return;
      if (/^https?:\/\//i.test(q) || /^\d{5,30}$/.test(q) || /series_id=\d+/i.test(q)) {
        setTab('input');
        setInputUrl(q);
        handleResolveValue(q);
      } else {
        setTab('search');
        setExternalQuery(q);
      }
    };
    window.addEventListener('hongguo:quick-search', onQuickSearch);
    return () => {
      window.removeEventListener('hongguo:quick-search', onQuickSearch);
      clearTimeout(toastTimer.current);
    };
  }, []);

  // 文字导出转为后台任务，完成后经 text-export-done 事件回报；本订阅只更新提示文案，不阻塞下载。
  useEffect(() => {
    const off = window.electronAPI?.onTextExportDone?.((data) => {
      const request = textExportRequest.current;
      if (!data || !request || request.done || data.requestId !== request.requestId
        || String(data.seriesId) !== String(request.seriesId)
        || String(data.seriesId) !== String(seriesIdRef.current)) return;
      request.done = true;
      const k = request.kinds;
      const part = (key, label) => k[key] && data[key]
        ? `${label} ${data[key].ok} 份${Number.isFinite(data[key].items) ? `，${data[key].items} 条` : ''}${data[key].empty ? `（空数据${data[key].empty}份）` : ''}${data[key].skipped ? `（跳过${data[key].skipped}）` : ''}${data[key].unavailable ? `，来源未开放${data[key].unavailable}集（未生成文件）` : ''}${data[key].fail ? `，失败${data[key].fail}` : ''}${data[key].partial ? `，部分${data[key].partial}（仅保存已获取数据）` : ''}` : null;
      const bits = [part('danmaku', '弹幕'), part('comments', '评论'), part('reviews', '剧评')].filter(Boolean);
      setExportNote(data.failed
        ? `文字导出未完成：${data.error || '未知错误'}`
        : `文字导出结果：${bits.join('、') || '无'}${(k.comments || k.reviews) ? '（评论/剧评受官网限制，仅公开可读部分）' : ''}`);
    });
    return () => { if (typeof off === 'function') off(); };
  }, []);

  const clearTextExport = () => {
    textExportRequest.current = null;
    setExportNote('');
    setExportSettingsNote('');
  };

  const switchTab = (next) => {
    if (next === tab) return;
    resolveRequest.current++;
    pendingResolve.current = null;
    setLoading(false);
    setTab(next);
  };

  // 搜索选中一部剧后：复用既有的选集下载界面
  const handleSeriesFromSearch = async (data, viewDetails = false) => {
    if (searchVersion !== resolveRequest.current) return;
    if (mobile && !viewDetails) {
      if (playPending.current) return;
      const first = data.episodes.find(ep => !ep.locked);
      if (!first) throw new Error('来源尚未开放可播放集数');
      playPending.current = true;
      try {
        const result = await window.electronAPI.playSeries({ seriesId: data.series_id, resume: true });
        if (!result?.success) throw new Error(result?.error || '打开播放器失败，请重试');
      } finally { playPending.current = false; }
      return;
    }
    resolveRequest.current++;
    setLoading(false);
    setRangeInput('');
    setErrorMsg('');
    setTab('input');
    setSeriesData(data);
    clearTextExport();
    setSelectedVids(new Set(data.episodes.filter((ep) => !ep.locked).map((ep) => ep.vid)));
    setSuccessMsg(`已选中《${data.series_title}》共 ${data.total} 集，可直接播放或提交下载`);
    document.querySelector('.main-content:not([hidden])')?.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // 解析红果短剧
  const handleResolveValue = async (rawValue) => {
    const value = String(rawValue ?? inputUrl).trim();
    if (!value) {
      setErrorMsg('请输入红果短剧分享链接或剧集 ID');
      return;
    }
    if (pendingResolve.current?.value === value) return;
    const request = ++resolveRequest.current;
    pendingResolve.current = { value, request };
    setTab('input');
    setInputUrl(value);
    setRangeInput('');
    setLoading(true);
    setErrorMsg('');
    setSuccessMsg('');
    setSeriesData(null);
    clearTextExport();
    setSelectedVids(new Set());

    try {
      const res = await window.electronAPI.hongguoResolve(value);
      if (request !== resolveRequest.current) return;
      if (res?.success && res.data) {
        setSeriesData(res.data);
        // 默认全选，网页未提供的集数自动尝试 App 片源。
        const allVids = new Set(res.data.episodes.filter((ep) => !ep.locked).map((ep) => ep.vid));
        setSelectedVids(allVids);
        setSuccessMsg(`解析成功！找到《${res.data.series_title}》共 ${res.data.total} 集`);
      } else {
        setErrorMsg(res?.error || '解析失败，请检查链接或网络');
      }
    } catch (err) {
      if (request === resolveRequest.current) setErrorMsg('解析过程出现错误: ' + err.message);
    } finally {
      if (pendingResolve.current?.request === request) pendingResolve.current = null;
      if (request === resolveRequest.current) setLoading(false);
    }
  };
  const handleResolve = () => handleResolveValue(inputUrl);

  // 勾选/取消勾选单集
  const toggleVid = (vid) => {
    if (!seriesData?.episodes.some((ep) => ep.vid === vid && !ep.locked)) return;
    const next = new Set(selectedVids);
    if (next.has(vid)) {
      next.delete(vid);
    } else {
      next.add(vid);
    }
    setSelectedVids(next);
  };

  // 全选
  const handleSelectAll = () => {
    if (!seriesData) return;
    setSelectedVids(new Set(seriesData.episodes.filter((ep) => !ep.locked).map((ep) => ep.vid)));
  };

  // 反选
  const handleInvertSelect = () => {
    if (!seriesData) return;
    const next = new Set();
    for (const ep of seriesData.episodes) {
      if (!ep.locked && !selectedVids.has(ep.vid)) {
        next.add(ep.vid);
      }
    }
    setSelectedVids(next);
  };

  // 清空选择
  const handleDeselectAll = () => {
    setSelectedVids(new Set());
  };

  // 快捷集数选择
  const handleQuickSelect = (type) => {
    if (!seriesData || !seriesData.episodes) return;
    const eps = seriesData.episodes;
    const total = eps.length;
    let targetEps = [];
    if (type === 'first10') {
      targetEps = eps.slice(0, 10);
    } else if (type === 'first30') {
      targetEps = eps.slice(0, 30);
    } else if (type === 'last30') {
      targetEps = eps.slice(Math.max(0, total - 30));
    }
    setSelectedVids(new Set(targetEps.filter((ep) => !ep.locked).map((ep) => ep.vid)));
  };

  // 根据区间字符串应用筛选 (如 "1-30" 或 "1,5,10-20")
  const handleApplyRange = () => {
    if (!seriesData?.episodes) return;
    try {
      const nums = parseEpisodeRange(rangeInput, seriesData.episodes.length);
      setSelectedVids(new Set(seriesData.episodes.filter((ep) => !ep.locked && nums.has(ep.vid_index)).map((ep) => ep.vid)));
      setErrorMsg('');
    } catch (error) { setErrorMsg(error.message); }
  };

  const handlePlay = async () => {
    if (!seriesData || !firstPlayable || playPending.current) return;
    const request = resolveRequest.current;
    playPending.current = true;
    setOpeningPlayer(true);
    setErrorMsg('');
    try {
      const res = await window.electronAPI.playSeries({ seriesId: seriesData.series_id, vidIndex: firstPlayable.vid_index });
      if (!res?.success && request === resolveRequest.current) setErrorMsg(res?.error || '打开播放器失败，请重试');
    } catch (error) {
      if (request === resolveRequest.current) setErrorMsg('打开播放器失败: ' + error.message);
    } finally {
      playPending.current = false;
      setOpeningPlayer(false);
    }
  };

  // 提交批量下载
  const handleBatchDownload = async () => {
    if (!seriesData || selectedVids.size === 0) {
      setErrorMsg('请至少勾选一集欲下载的短剧');
      return;
    }
    const kinds = isHongguoSource ? { ...exportKinds } : { danmaku: false, comments: false, reviews: false };
    const wantExport = kinds.danmaku || kinds.comments || kinds.reviews;
    const request = { requestId: crypto.randomUUID(), seriesId: seriesData.series_id, kinds, done: !wantExport };
    textExportRequest.current = request;
    setExportNote(wantExport ? '正在后台导出文字数据…' : '');
    setExportSettingsNote('');
    setSubmitting(true);
    setErrorMsg('');
    setSuccessMsg('');
    try {
      const selectedEps = seriesData.episodes.filter((ep) => !ep.locked && selectedVids.has(ep.vid));
      const res = await window.electronAPI.hongguoDownloadBatch({
        seriesId: seriesData.series_id,
        seriesTitle: seriesData.series_title,
        episodes: selectedEps,
        quality: downloadQuality,
        export: kinds,
        requestId: request.requestId,
      });
      const isCurrent = () => textExportRequest.current === request && seriesIdRef.current === request.seriesId;
      if (res.success) {
        if (isHongguoSource) {
          // 偏好保存失败不改变已提交的视频任务或后台导出结果。
          Promise.resolve().then(() => window.electronAPI.saveSettings({ export_text: kinds })).then(saved => {
            if (!saved?.success) throw new Error(saved?.error || '请稍后重试');
          }).catch(error => {
            if (isCurrent()) setExportSettingsNote(`导出选项未保存：${error.message || '请稍后重试'}；本次视频已提交，文字导出不受影响。`);
          });
        }
        if (isCurrent()) {
          setPendingCount(c => c + (res.count || selectedEps.length));
          setDownloadToast({ count: res.count, text: `已将 ${res.count} 集加入下载队列` });
          clearTimeout(toastTimer.current);
          toastTimer.current = setTimeout(() => setDownloadToast(null), 5000);
        }
      } else if (isCurrent()) {
        textExportRequest.current = null;
        setExportNote('');
        setErrorMsg(res.error || '提交下载失败');
      }
    } catch (err) {
      if (textExportRequest.current === request && seriesIdRef.current === request.seriesId) {
        textExportRequest.current = null;
        setExportNote('');
        setErrorMsg('提交下载异常: ' + err.message);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleChooseFolder = async () => {
    try {
      const folder = await window.electronAPI.selectFolder?.();
      if (!folder) return;
      const saved = await window.electronAPI.saveSettings?.({ download_dir: folder });
      if (saved?.success !== false) setDownloadDir(folder);
    } catch {
      setErrorMsg('文件夹选择失败，请重试');
    }
  };

  const selectedExportLabels = [
    exportKinds.danmaku && t('弹幕'),
    exportKinds.comments && t('评论'),
    exportKinds.reviews && t('剧评'),
  ].filter(Boolean);

  return (
    <div className="hongguo-container">
      {/* 5. Unified Search Bar */}
      <div className="sd-search-section">
        <div className="sd-top-bar">
          <div className="mode-tabs">
            <button
              className={`mode-tab ${tab === 'search' ? 'active' : ''}`}
              onClick={() => switchTab('search')}
            >
              <Search size={15} />
              <span>{t("搜索剧集")}</span>
            </button>
            <button
              className={`mode-tab ${tab === 'input' ? 'active' : ''}`}
              onClick={() => switchTab('input')}
            >
              <Link2 size={15} />
              <span>{t("粘贴链接 / ID")}</span>
            </button>
          </div>
          {onNavigate && (
            <button type="button" className="btn btn-outline btn-sm sd-queue-btn" onClick={() => onNavigate('manager')}>
              <Folder size={14} />
              <span>{t("查看下载管理")}</span>
              {pendingCount > 0 && <span className="sd-queue-badge">{pendingCount}</span>}
            </button>
          )}
        </div>

        <div hidden={tab !== 'search'}>
          <SearchPanel
            active={active && tab === 'search'}
            externalQuery={externalQuery}
            compactWelcome={!!seriesData}
            onResolveInput={(val) => handleResolveValue(val)}
            onSelectSeries={handleSeriesFromSearch}
            onViewSeries={mobile ? data => handleSeriesFromSearch(data, true) : undefined}
            onSwitchToInput={() => switchTab('input')}
          />
        </div>

        {tab === 'input' && (
          <div className="hongguo-card sd-url-card">
            <div className="input-group">
              <div className="unified-input-wrap">
                <Link2 size={15} className="unified-input-icon" />
                <input
                  type="text"
                  className="input-field"
                  aria-label={t("短剧分享链接或剧集 ID")}
                  placeholder={t("粘贴短剧分享链接，或输入剧集 ID")}
                  value={inputUrl}
                  onChange={(e) => { resolveRequest.current++; pendingResolve.current = null; setLoading(false); setInputUrl(e.target.value); }}
                  onKeyDown={(e) => isSubmitKey(e) && handleResolve()}
                />
                {inputUrl && (
                  <button type="button" className="unified-clear-btn" aria-label={t("清空")} title={t("清空")} onClick={() => { setInputUrl(''); setErrorMsg(''); }}>
                    <X size={14} />
                  </button>
                )}
              </div>
              <button className="btn btn-outline" disabled={loading} onClick={async () => {
                try {
                  const text = (await navigator.clipboard.readText()).trim();
                  if (!text || text.length > 4096) throw new Error('剪贴板为空或内容过长，请手动粘贴短剧链接');
                  resolveRequest.current++;
                  pendingResolve.current = null;
                  setInputUrl(text);
                  setErrorMsg('');
                  setSuccessMsg('已粘贴，请确认链接后获取剧集');
                } catch (error) { setErrorMsg(error.message || '读取剪贴板失败，请手动粘贴'); }
              }}>{t("粘贴链接")}</button>
              <button className="btn btn-primary" onClick={handleResolve} disabled={loading}>
                {loading ? (
                  <>
                    <RefreshCw size={15} className="spin" />
                    <span>{t("解析中...")}</span>
                  </>
                ) : (
                  <>
                    <Film size={15} />
                    <span>{t("获取剧集")}</span>
                  </>
                )}
              </button>
            </div>
            {errorMsg && <div className="alert alert-error" role="alert">{t(errorMsg)}</div>}
            {successMsg && !seriesData && <div className="alert alert-success" role="status">{t(successMsg)}</div>}
          </div>
        )}

        {tab === 'search' && (errorMsg || (successMsg && !seriesData)) && (
          <div className="hongguo-card sd-url-card">
            {errorMsg && <div className="alert alert-error" role="alert">{t(errorMsg)}</div>}
            {successMsg && !seriesData && <div className="alert alert-success" role="status">{t(successMsg)}</div>}
          </div>
        )}
      </div>

      {/* 6-9. Loaded Drama Workspace */}
      {seriesData && (
        <div className="sd-workspace">
          {/* 6. Compact Drama Information Panel */}
          <div className="sd-drama-info-card">
            <div className="sd-drama-poster-wrap">
              {seriesData.cover ? (
                <img src={seriesData.cover} alt={seriesData.series_title} className="sd-drama-poster" />
              ) : (
                <div className="sd-drama-poster-placeholder"><Film size={28} /></div>
              )}
              {firstPlayable && (
                <button type="button" className="sd-poster-play-overlay" onClick={handlePlay} disabled={openingPlayer} title={t("立即播放")} aria-label={t("立即播放")}>
                  <Play size={18} />
                </button>
              )}
            </div>

            <div className="sd-drama-meta">
              <div className="sd-drama-title-row">
                <h3 className="series-title">《{seriesData.series_title}》</h3>
                <div className="series-tags">
                  <span className="sd-meta-badge">{mediaSourceLabel(seriesData.series_id, mediaSources)}</span>
                  <span className="sd-meta-badge">{t("共 ")}{t(seriesData.total)}{t(" 集")}</span>
                  <span className="sd-meta-badge is-accent">{t("已选 ")}{t(selectedVids.size)}{t(" 集")}</span>
                </div>
              </div>

              <div className="sd-drama-synopsis">
                {description ? (
                  <>
                    <p id="series-description-text" className={introExpanded ? 'is-expanded' : ''}>{description}</p>
                    {description.length > 100 && (
                      <button type="button" className="sd-expand-btn" aria-expanded={introExpanded}
                        aria-controls="series-description-text" onClick={() => setIntroExpanded(value => !value)}>
                        {t(introExpanded ? '收起简介' : '展开简介')}
                      </button>
                    )}
                  </>
                ) : (
                  <p role="status" className="is-muted">{t(publicIntro?.seriesId === seriesData.series_id && publicIntro.loading ? '简介加载中…'
                    : publicIntro?.seriesId === seriesData.series_id && publicIntro.failed ? '简介暂未获取，请稍后重新打开剧集。' : '当前来源暂无剧情简介')}</p>
                )}
              </div>

              <div className="sd-drama-actions">
                <div className="sd-drama-action-buttons">
                  <button className="btn btn-primary btn-sm" onClick={handlePlay}
                    disabled={openingPlayer || !firstPlayable}
                    title={t(firstPlayable ? '在我的剧库播放，未下载的分集会在线播放' : '当前剧集没有可播放的分集')}>
                    {openingPlayer ? <RefreshCw size={14} className="spin" /> : <Play size={14} />}
                    <span>{t(openingPlayer ? '正在打开…' : '立即播放')}</span>
                  </button>
                  {onNavigate && (
                    <button className="btn btn-outline btn-sm" onClick={() => onNavigate('manager')}>
                      <Folder size={14} />
                      <span>{t("查看下载管理")}</span>
                    </button>
                  )}
                </div>

                {isHongguoSource && (
                  <div className="sd-export-toolbar" role="group" aria-label={t("随下载导出的文字数据")}>
                    <span className="batch-export-title">{t("随下载导出")}</span>
                    <div className="sd-export-checks">
                      {[['danmaku', '弹幕'], ['comments', '评论'], ['reviews', '剧评']].map(([key, label]) => (
                        <label key={key} className="batch-export-check">
                          <input type="checkbox" aria-label={t(label)} checked={exportKinds[key]}
                            disabled={qualityLoading || submitting}
                            onChange={(event) => setExportKinds(prev => ({ ...prev, [key]: event.target.checked }))} />
                          <span>{t(label)}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                )}
              </div>
              {isHongguoSource && exportNote && <span className="sd-export-status" role="status">{t(exportNote)}</span>}
              {isHongguoSource && exportSettingsNote && <span className="sd-export-status is-error" role="alert">{t(exportSettingsNote)}</span>}
            </div>
          </div>

          {/* 8 & 9. Split Workspace: Episode Selection (left) + Download Settings (right) */}
          <div className="sd-split-layout">
            {/* 8. Episode Selection Panel */}
            <div className="hongguo-card sd-episode-panel">
              <div className="sd-panel-header">
                <div className="sd-panel-title-wrap">
                  <h4>{t("点选需要下载的集数")}</h4>
                  <span className="sd-selected-counter">{selectedVids.size} / {seriesData.total}</span>
                </div>
                <div className="range-filter">
                  <input
                    type="text"
                    className="range-input"
                    aria-label={t("选择集数范围")}
                    placeholder={t("如 1-30 或 1,5,10")}
                    value={rangeInput}
                    onChange={(e) => setRangeInput(e.target.value)}
                    onKeyDown={(e) => isSubmitKey(e) && handleApplyRange()}
                  />
                  <button className="btn btn-outline btn-sm" onClick={handleApplyRange}>{t("应用")}</button>
                </div>
              </div>

              <div className="controls-row">
                <div className="select-buttons">
                  <button className="btn-chip" onClick={handleSelectAll}>{t("全选")}</button>
                  <button className="btn-chip" onClick={handleDeselectAll}>{t("取消全选")}</button>
                  <button className="btn-chip" onClick={handleInvertSelect}>{t("反选")}</button>
                  <span className="divider"></span>
                  <button className="btn-chip" onClick={() => handleQuickSelect('first10')}>{t("前 10 集")}</button>
                  <button className="btn-chip" onClick={() => handleQuickSelect('first30')}>{t("前 30 集")}</button>
                  <button className="btn-chip" onClick={() => handleQuickSelect('last30')}>{t("后 30 集")}</button>
                </div>
              </div>

              {seriesData.web_accessible_episodes != null && seriesData.web_accessible_episodes < seriesData.total && (
                <p className="settings-hint sd-panel-note">{t("网页源提供前 ")}{t(seriesData.web_accessible_episodes)}{t(" 集，后续集数自动尝试 App 片源。")}</p>
              )}
              {seriesData.episodes.some((ep) => ep.locked) && (
                <p className="settings-hint sd-panel-note">{t("锁定集需在来源平台解锁，本应用不提供解锁；全选和范围选择会自动跳过。")}</p>
              )}

              <div className="episode-grid">
                {seriesData.episodes.map((ep) => {
                  const isChecked = selectedVids.has(ep.vid);
                  return (
                    <button
                      type="button"
                      disabled={ep.locked === true}
                      title={t(ep.locked ? '需在来源平台解锁' : ep.title || `第 ${ep.vid_index} 集`)}
                      aria-pressed={isChecked}
                      key={ep.vid}
                      className={`episode-card ${isChecked ? 'selected' : ''}`}
                      onClick={() => toggleVid(ep.vid)}
                    >
                      <span className="checkbox-icon">
                        {isChecked ? <CheckSquare size={15} className="icon-checked" /> : <Square size={15} className="icon-unchecked" />}
                      </span>
                      <span className="episode-num">{String(ep.vid_index).padStart(2, '0')}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* 9. Download Settings Panel */}
            <aside className="hongguo-card sd-settings-panel">
              <h4 className="sd-settings-title">{t("下载清晰度")}</h4>

              <div className="sd-setting-block">
                <label className="sd-setting-label" htmlFor="sd-quality-select">{t("下载清晰度")}</label>
                <select id="sd-quality-select" className="input-field" value={downloadQuality}
                  disabled={qualityLoading || submitting}
                  onChange={(event) => setDownloadQuality(event.target.value)}>
                  <option value="auto">{t("自动（兼容优先）")}</option>
                  <option value="1080p">1080P</option>
                  <option value="720p">720P</option>
                </select>
              </div>

              {!mobile && (
                <div className="sd-setting-block">
                  <span className="sd-setting-label">{t("下载目录")}</span>
                  <div className="sd-dest-row">
                    <span className="sd-dest-path" title={downloadDir}>{downloadDir || t('系统配置目录')}</span>
                    <button type="button" className="btn btn-outline btn-sm" onClick={handleChooseFolder}>
                      <Folder size={13} />{t("选择文件夹")}
                    </button>
                  </div>
                </div>
              )}

              <div className="sd-summary-box">
                <div className="sd-summary-row"><span>{t("共")}</span><b>{seriesData.total}</b></div>
                <div className="sd-summary-row"><span>{t("已选")}</span><b>{selectedVids.size}</b></div>
                <div className="sd-summary-row"><span>{t("清晰度")}</span><b>{downloadQuality === 'auto' ? t('自动') : downloadQuality.toUpperCase()}</b></div>
                <div className="sd-summary-row"><span>{t("随下载导出")}</span><b>{selectedExportLabels.length ? selectedExportLabels.join(', ') : t('无')}</b></div>
              </div>

              <button
                className="btn btn-primary sd-download-cta"
                onClick={handleBatchDownload}
                disabled={qualityLoading || submitting || selectedVids.size === 0}
              >
                {submitting ? <RefreshCw size={16} className="spin" /> : <Download size={16} />}
                <span>{t("下载选中集数 (")}{selectedVids.size})</span>
              </button>
            </aside>
          </div>
        </div>
      )}

      {/* 11. Compact Floating Download Toast */}
      {downloadToast && (
        <div className="sd-toast" role="status">
          <Check size={16} className="sd-toast-icon" />
          <span>{t("已将 {0} 集加入下载队列", [downloadToast.count])}</span>
          {onNavigate && (
            <button type="button" className="btn btn-outline btn-sm" onClick={() => { setDownloadToast(null); onNavigate('manager'); }}>
              {t("查看下载管理")}
            </button>
          )}
          <button type="button" className="icon-btn" aria-label={t("关闭")} onClick={() => setDownloadToast(null)}>
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

export default HongguoDownload;

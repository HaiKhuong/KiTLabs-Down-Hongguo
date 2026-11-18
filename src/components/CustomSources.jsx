import { t, useLanguage } from '../i18n';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import useDialogKeyboard from './useDialogKeyboard';
import { Globe, Plus, RefreshCw, X } from './icons';
import { notifyMediaSourcesChanged } from './useMediaSources';
import { waitForRequest } from './randomDramaModel.mjs';
import './CustomSources.css';

const emptyDraft = () => ({ name: '', url: '', enabled: true });

export default function CustomSources({ active = true }) {
  useLanguage();
  const [sources, setSources] = useState([]);
  const [draft, setDraft] = useState(emptyDraft);
  const [modalOpen, setModalOpen] = useState(false);
  const [busy, setBusy] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState('');
  const listVersion = useRef(0);
  const testController = useRef(null);
  const mutation = useRef(false);

  const load = useCallback(async () => {
    const version = ++listVersion.current;
    setLoading(true);
    try {
      const result = await window.electronAPI.getCustomSources();
      if (version !== listVersion.current) return;
      if (!result?.success) throw new Error(result?.error || '自定义源加载失败');
      setSources(result.sources || []);
    } catch (cause) { if (version === listVersion.current) setError(cause.message || '自定义源加载失败'); }
    finally { if (version === listVersion.current) setLoading(false); }
  }, []);

  useEffect(() => {
    if (active) load();
    else {
      testController.current?.abort();
      setBusy(current => current === 'test' ? '' : current);
    }
    return () => { listVersion.current++; testController.current?.abort(); };
  }, [active, load]);

  const closeModal = () => {
    if (mutation.current) return;
    testController.current?.abort();
    setBusy('');
    setModalOpen(false);
    setDraft(emptyDraft());
    setMessage('');
    setError('');
  };

  useDialogKeyboard(active && modalOpen, closeModal, '.custom-source-modal');

  const patch = (key, value) => {
    testController.current?.abort();
    setMessage('');
    setError('');
    setDraft(current => ({ ...current, [key]: value }));
  };

  const openAdd = () => {
    testController.current?.abort();
    setDraft(emptyDraft());
    setDeleting('');
    setMessage('');
    setError('');
    setModalOpen(true);
  };

  const edit = source => {
    testController.current?.abort();
    setDraft({ ...source });
    setDeleting('');
    setMessage('');
    setError('');
    setModalOpen(true);
  };

  const test = async () => {
    if (busy || mutation.current) return;
    const controller = new AbortController();
    testController.current = controller;
    setBusy('test');
    setMessage('');
    setError('');
    try {
      const result = await waitForRequest(window.electronAPI.testCustomSource(draft), { signal: controller.signal, message: '测试超时，请检查 API 地址后重试' });
      if (controller.signal.aborted) return;
      if (!result?.success) throw new Error(result?.error || '测试失败，请检查 API 地址');
      setMessage(`目录连接成功，返回 ${result.count || 0} 部。测试不代表每一集都能播放；保存后加入来源。`);
    } catch (cause) { if (!controller.signal.aborted) setError(cause.message || '来源测试失败'); }
    finally { if (!controller.signal.aborted) setBusy(''); }
  };

  const persist = async (source, kind = 'save') => {
    if (busy || mutation.current) return;
    mutation.current = true;
    setBusy(kind);
    setMessage('');
    setError('');
    try {
      const result = kind === 'delete' ? await window.electronAPI.deleteCustomSource(source.id)
        : await window.electronAPI.saveCustomSource(source);
      if (!result?.success) throw new Error(result?.error || '来源配置未保存，请重试');
      notifyMediaSourcesChanged();
      if (kind === 'save') {
        setDraft(emptyDraft());
        setModalOpen(false);
      } else if (kind === 'delete' && draft.id === source.id) {
        setDraft(emptyDraft());
      }
      setDeleting('');
      setMessage(kind === 'delete' ? '已移除来源配置，本地视频保留。' : kind === 'toggle' ? (source.enabled ? '来源已启用。' : '来源已停用。') : '来源已保存，可在搜索、发现和摇一摇中选择。');
      await load();
    } catch (cause) { setError(cause.message || '来源配置未保存，请重试'); }
    finally { mutation.current = false; setBusy(''); }
  };

  return (
    <section className="settings-card custom-sources" aria-labelledby="custom-sources-title">
      <div className="custom-sources-head-row">
        <div>
          <div className="custom-sources-heading"><Globe size={16} /><h3 id="custom-sources-title">{t("自定义播放源")}</h3></div>
          <p className="settings-hint">{t("接入你有权使用的苹果 CMS V10 JSON API。仅支持接口返回的 MP4 / M3U8 直链。")}</p>
        </div>
        <button type="button" className="btn btn-primary btn-sm" onClick={openAdd}>
          <Plus size={14} /><span>{t("添加来源")}</span>
        </button>
      </div>

      {!modalOpen && message && <p className="custom-source-message" role="status">{t(message)}</p>}
      {!modalOpen && error && (
        <div className="custom-source-error" role="alert">
          <p>{t(error)}</p>
          <button className="btn btn-outline btn-sm" disabled={!!busy || loading} onClick={() => { setError(''); load(); }}>{t("重新读取配置")}</button>
        </div>
      )}

      <div className="custom-source-list" aria-label={t("已保存的自定义源")}>
        {loading && <p className="settings-hint" role="status">{t("正在读取来源…")}</p>}
        {!loading && sources.length === 0 && <p className="settings-hint">{t("还没有自定义源。内置来源可在上方设置。")}</p>}
        {sources.map(source => (
          <div className="custom-source-row" key={source.id}>
            <div className="custom-source-info">
              <div className="custom-source-title-row">
                <strong>{source.name}</strong>
                <span className={`custom-source-status ${source.enabled ? 'is-on' : ''}`}>{t(source.enabled ? '已启用' : '已停用')}</span>
              </div>
              <p>{source.url}</p>
            </div>
            <div className="custom-source-actions">
              <button className="btn btn-outline btn-sm" disabled={!!busy} onClick={() => persist({ ...source, enabled: !source.enabled }, 'toggle')}>{t(source.enabled ? '停用' : '启用')}</button>
              <button className="btn btn-outline btn-sm" disabled={!!busy} onClick={() => edit(source)}>{t("编辑")}</button>
              <button className="btn btn-outline btn-sm" disabled={!!busy} onClick={() => setDeleting(source.id)}>{t("删除")}</button>
            </div>
            {deleting === source.id && (
              <div className="custom-source-delete" role="group" aria-label={t(`确认删除${source.name}`)}>
                <p>{t("移除「")}{source.name}{t("」配置？本地视频会保留；此来源在线播放将不可用。")}</p>
                <button className="btn btn-danger-solid btn-sm" disabled={!!busy} onClick={() => persist(source, 'delete')}>{t("确认移除")}</button>
                <button className="btn btn-outline btn-sm" disabled={!!busy} onClick={() => setDeleting('')}>{t("保留来源")}</button>
              </div>
            )}
          </div>
        ))}
      </div>

      {modalOpen && (
        <div className="proxy-modal-mask" onClick={closeModal}>
          <div className="proxy-modal custom-source-modal" role="dialog" aria-modal="true" aria-label={t(draft.id ? "编辑来源" : "添加来源")} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
            <div className="proxy-modal-head">
              <div className="proxy-modal-title">
                <Globe size={18} />
                <span>{t(draft.id ? "编辑自定义来源" : "添加自定义来源")}</span>
              </div>
              <button type="button" className="icon-btn" title={t("关闭")} disabled={busy === 'save'} onClick={closeModal}>
                <X size={16} />
              </button>
            </div>
            <form onSubmit={event => { event.preventDefault(); persist(draft); }}>
              <fieldset disabled={busy === 'save'} className="proxy-modal-body custom-source-form">
                <label className="settings-group">
                  <span className="settings-label">{t("来源名称")}</span>
                  <input className="input-field" value={draft.name} maxLength={60} required placeholder={t("例如：我的片库")} onChange={event => patch('name', event.target.value)} />
                </label>
                <label className="settings-group">
                  <span className="settings-label">{t("API 地址")}</span>
                  <input className="input-field" type="url" value={draft.url} maxLength={2048} required placeholder="https://example.com/api.php/provide/vod/" spellCheck={false} autoComplete="off" onChange={event => patch('url', event.target.value)} />
                </label>
                <label className="custom-source-enabled">
                  <input type="checkbox" checked={draft.enabled !== false} onChange={event => patch('enabled', event.target.checked)} />
                  <span>{t("保存后启用")}</span>
                </label>
                {message && <p className="custom-source-message" role="status">{t(message)}</p>}
                {error && <p className="alert alert-error" role="alert">{t(error)}</p>}
              </fieldset>
              <div className="proxy-modal-foot">
                <div className="proxy-foot-right">
                  <button type="button" className="btn btn-outline" disabled={!draft.name.trim() || !draft.url.trim() || busy === 'save'} onClick={test}>
                    <RefreshCw size={14} className={busy === 'test' ? 'spin' : ''} /><span>{t(busy === 'test' ? '测试中…' : '测试连接')}</span>
                  </button>
                  {busy === 'test' && (
                    <button type="button" className="btn btn-outline btn-sm" onClick={() => { testController.current?.abort(); setBusy(''); setMessage('已取消测试。'); }}>
                      {t("取消测试")}
                    </button>
                  )}
                </div>
                <div className="proxy-foot-right">
                  <button type="button" className="btn btn-outline" disabled={busy === 'save'} onClick={closeModal}>{t("取消")}</button>
                  <button className="btn btn-primary" type="submit" disabled={busy === 'save'}>{t(busy === 'save' ? '保存中…' : draft.id ? '保存修改' : '保存来源')}</button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}
    </section>
  );
}

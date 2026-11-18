import { t, useLanguage, getLanguage } from '../i18n';
import React, { useEffect, useRef, useState } from 'react';
import {
  CheckCircle, ChevronDown, Clock, ExternalLink, Play, QrCode,
  RefreshCw, Search, Shield, Smartphone, User
} from './icons';
import './AccountManagement.css';

export default function AccountManagement({ active = true }) {
  useLanguage();
  const [account, setAccount] = useState(null);
  const [rows, setRows] = useState([]);
  const [query, setQuery] = useState('');
  const [qr, setQr] = useState(null);
  const [loading, setLoading] = useState(true);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const request = useRef(0);
  const historyRequest = useRef(0);
  const generation = useRef(0);
  const pollTimer = useRef(null);
  const visibleRows = rows.filter(row => !query.trim() || row.series_title.includes(query.trim()));

  const loadHistory = async (refresh = false) => {
    const version = ++historyRequest.current;
    setHistoryLoading(true);
    try {
      const result = await window.electronAPI.getAccountHistory?.({ refresh });
      if (version !== historyRequest.current) return;
      if (!result?.success) throw new Error(result?.error || 'APP 观看记录加载失败');
      setRows(result.signedIn ? result.results || [] : []);
      if (result.warning) setStatus(`已读取 APP 记录；${result.warning}`);
    } catch (failure) {
      if (version === historyRequest.current) setError(failure.message || 'APP 观看记录加载失败，请重试');
    } finally {
      if (version === historyRequest.current) setHistoryLoading(false);
    }
  };

  const load = async () => {
    const version = ++request.current;
    try {
      const result = await window.electronAPI.getAccountStatus?.();
      if (version !== request.current) return;
      if (!result?.success) throw new Error(result?.error || '账号状态读取失败');
      setAccount(result.account || null);
      setError(result.error || '');
      setLoading(false);
      if (result.signedIn) {
        await loadHistory();
      } else {
        historyRequest.current++;
        setRows([]);
      }
    } catch (failure) {
      if (version === request.current) setError(failure.message || '账号状态读取失败，请重试');
    } finally {
      if (version === request.current) {
        setLoading(false);
      }
    }
  };

  const schedulePoll = (loginId, token) => {
    clearTimeout(pollTimer.current);
    pollTimer.current = setTimeout(async () => {
      if (token !== generation.current) return;
      try {
        const result = await window.electronAPI.pollAccountLogin?.(loginId);
        if (token !== generation.current) return;
        if (!result?.success) throw new Error(result?.error || '扫码状态读取失败');
        if (result.status === 'signed-in') {
          generation.current++;
          setBusy(false); setQr(null); setAccount(result.account || null);
          setStatus(result.storageWarning || '登录成功');
          loadHistory();
          return;
        }
        if (result.status === 'cancelled') { setBusy(false); setQr(null); setStatus('扫码已取消'); return; }
        if (result.status === 'expired') {
          setBusy(false); setQr(null); setError('二维码已过期，请重新获取。');
          return;
        }
        setStatus('等待手机确认扫码登录…');
        schedulePoll(loginId, token);
      } catch (failure) {
        if (token === generation.current) {
          setBusy(false); setQr(null);
          setError(failure.message || '扫码登录未完成，请重试');
        }
      }
    }, 1000);
  };

  const beginLogin = async () => {
    const token = ++generation.current;
    clearTimeout(pollTimer.current);
    setBusy(true); setError(''); setStatus('正在获取红果登录二维码…');
    try {
      const result = await window.electronAPI.startAccountLogin?.();
      if (token !== generation.current) return;
      if (!result?.success) throw new Error(result?.error || '二维码获取失败');
      setQr({ id: result.loginId, image: result.image });
      setStatus(`请用手机红果 App 扫码，并在手机上确认登录。二维码约 ${result.expiresIn} 秒有效。`);
      schedulePoll(result.loginId, token);
    } catch (failure) {
      if (token === generation.current) {
        setBusy(false);
        setError(failure.message || '二维码获取失败，请重试');
      }
    }
  };

  const cancelLogin = async () => {
    generation.current++;
    clearTimeout(pollTimer.current);
    const id = qr?.id;
    setQr(null); setBusy(false); setStatus('已取消扫码登录');
    if (id) await window.electronAPI.cancelAccountLogin?.(id).catch(() => {});
  };

  const openWebLogin = async () => {
    try {
      const result = await window.electronAPI.openAccountWebLogin();
      if (!result?.success) throw new Error(result?.error || '打开官网登录失败');
    } catch (e) { setError(e.message); }
  };

  const logout = async () => {
    setBusy(true); setError(''); setStatus('');
    try {
      const result = await window.electronAPI.logoutAccount?.();
      if (!result?.success) throw new Error(result?.error || '退出账号失败');
      historyRequest.current++;
      setAccount(null); setRows([]); setQuery(''); setStatus('已退出红果账号，本机记录不受影响。');
    } catch (failure) { setError(failure.message || '退出账号失败，请重试'); }
    finally { setBusy(false); }
  };

  const open = async row => {
    if (!active || busy) return;
    setBusy(true); setError('');
    try {
      const result = await window.electronAPI.playAccountHistory?.(row.series_id);
      if (!result?.success) throw new Error(result?.error || '打开 APP 观看记录失败');
    } catch (failure) { setError(failure.message || '打开 APP 观看记录失败，请重试'); }
    finally { setBusy(false); }
  };

  useEffect(() => {
    if (active) load();
    return () => { request.current++; historyRequest.current++; };
  }, [active]);
  useEffect(() => window.electronAPI.onAccountUpdated?.(result => {
    if (!active) return;
    if (result?.error) setError(result.error);
    else load();
  }), [active]);
  useEffect(() => () => {
    generation.current++;
    clearTimeout(pollTimer.current);
  }, []);

  if (loading) {
    return (
      <div className="account-page">
        <div className="acc-loading-card" role="status">
          <RefreshCw size={20} className="spin" />
          <span>{t("正在读取红果账号…")}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="account-page">
      {/* 2. Page Header */}
      <header className="acc-header">
        <div className="acc-header-left">
          <div className="acc-header-icon"><User size={20} /></div>
          <div>
            <h2>{t("红果账号")}</h2>
            <p className="acc-subtitle">{t("网页扫码登录红果账号，读取 APP 观看记录。")}</p>
          </div>
        </div>
        <div className={`acc-conn-pill ${account ? 'is-connected' : qr ? 'is-waiting' : ''}`}>
          <span className="acc-conn-dot" />
          <span>{t(account ? '已登录红果账号' : qr ? '等待手机确认扫码登录…' : '未连接')}</span>
        </div>
      </header>

      {/* 3 & 4. Unauthenticated Two-Column Layout */}
      {!account ? (
        <div className="acc-auth-grid">
          {/* Left Column: Account Information Card (52%) */}
          <section className="acc-info-card">
            <div className="acc-info-top">
              <h3>{t("连接红果账号")}</h3>
              <p className="acc-info-desc">{t("网页扫码登录红果账号，读取 APP 观看记录。")}</p>
            </div>

            <ul className="acc-benefits">
              <li>
                <span className="acc-benefit-icon"><Clock size={16} /></span>
                <div>
                  <strong>{t("读取 APP 观看记录")}</strong>
                  <span>{t("最近 50 部；不会批量导入本机记录")}</span>
                </div>
              </li>
              <li>
                <span className="acc-benefit-icon"><Play size={16} /></span>
                <div>
                  <strong>{t("继续观看")}</strong>
                  <span>{t("点击记录直接打开剧库续播对应剧集")}</span>
                </div>
              </li>
              <li>
                <span className="acc-benefit-icon"><Shield size={16} /></span>
                <div>
                  <strong>{t("系统安全存储")}</strong>
                  <span>{t("登录态由系统安全存储加密，普通资料备份不会包含账号凭据。")}</span>
                </div>
              </li>
            </ul>

            <div className="acc-phone-visual" aria-hidden="true">
              <Smartphone size={22} />
              <span>{t("手机红果 App → 我的 → 扫一扫")}</span>
            </div>
          </section>

          {/* Right Column: QR Authentication Card (48%) */}
          <section className="acc-qr-card" aria-label={t("红果账号状态")}>
            <div className="acc-qr-head">
              <h3>{t("扫码登录")}</h3>
              <p>{t("使用手机红果 App 扫码并确认。登录态由系统安全存储加密，普通资料备份不会包含账号凭据。")}</p>
            </div>

            <div className="acc-qr-stage">
              {qr ? (
                <div className="acc-qr-frame">
                  <img src={qr.image} alt={t("红果登录二维码")} />
                </div>
              ) : (
                <div className="acc-qr-placeholder">
                  <QrCode size={46} />
                  <span>{t(busy ? '正在获取红果登录二维码…' : '获取登录二维码')}</span>
                </div>
              )}
            </div>

            <div className="acc-qr-actions">
              {qr ? (
                <>
                  <button className="btn btn-primary" type="button" onClick={beginLogin}>
                    <RefreshCw size={14} /><span>{t("刷新二维码")}</span>
                  </button>
                  <button className="btn btn-outline" type="button" onClick={cancelLogin}>
                    <span>{t("取消扫码")}</span>
                  </button>
                </>
              ) : (
                <>
                  <button className="btn btn-primary" type="button" disabled={busy} onClick={beginLogin}>
                    <QrCode size={15} /><span>{t(busy ? '正在获取二维码…' : '获取登录二维码')}</span>
                  </button>
                  <button className="btn btn-outline" type="button" disabled={busy} onClick={openWebLogin}>
                    <ExternalLink size={14} /><span>{t("使用官网登录")}</span>
                  </button>
                </>
              )}
            </div>

            {status && <p className="acc-status-msg" role="status">{t(status)}</p>}
            {error && <div className="alert alert-error acc-error-msg" role="alert"><span>{t(error)}</span></div>}
          </section>
        </div>
      ) : (
        /* 5. Login Success State */
        <div className="acc-signed-layout">
          <section className="acc-profile-card" aria-label={t("红果账号状态")}>
            <div className="acc-profile-left">
              <div className="acc-avatar"><User size={24} /></div>
              <div className="acc-profile-meta">
                <div className="acc-profile-name-row">
                  <strong>{account.nickname}</strong>
                  <span className="acc-verified-badge"><CheckCircle size={12} /><span>{t("已登录红果账号")}</span></span>
                </div>
                <p>
                  {t("APP 观看记录")}: <b>{t(historyLoading && !rows.length ? '读取中' : `${rows.length} 部`)}</b>
                  {' · '}
                  <span>{t("最近 50 部；不会批量导入本机记录")}</span>
                </p>
              </div>
            </div>
            <div className="acc-profile-actions">
              <button
                className="btn btn-outline btn-sm"
                type="button"
                disabled={busy || historyLoading}
                onClick={async () => {
                  setBusy(true); setError(''); setStatus('');
                  try { await loadHistory(true); } finally { setBusy(false); }
                }}
              >
                <RefreshCw size={14} className={historyLoading ? 'spin' : ''} /><span>{t("刷新记录")}</span>
              </button>
              <button className="btn btn-outline btn-sm" type="button" disabled={busy} onClick={logout}>
                <span>{t("退出账号")}</span>
              </button>
            </div>
          </section>

          {status && <p className="acc-status-msg" role="status">{t(status)}</p>}
          {error && <div className="alert alert-error acc-error-msg" role="alert"><span>{t(error)}</span></div>}

          <section className="acc-history-card">
            <div className="acc-history-head">
              <h3>{t("观看记录")}</h3>
              <div className="acc-search-wrap">
                <Search size={14} />
                <input
                  type="search"
                  value={query}
                  onChange={event => setQuery(event.target.value)}
                  placeholder={t("输入剧名")}
                  aria-label={t("搜索")}
                />
              </div>
            </div>

            {historyLoading && !rows.length ? (
              <div className="acc-history-empty" role="status">{t("正在读取 APP 观看记录…")}</div>
            ) : !rows.length ? (
              <div className="acc-history-empty">{t("APP 还没有观看记录。")}</div>
            ) : !visibleRows.length ? (
              <div className="acc-history-empty">{t("没有匹配的 APP 记录。")}</div>
            ) : (
              <ul className="acc-history-list">
                {visibleRows.map(row => (
                  <li key={row.series_id}>
                    <button
                      type="button"
                      className="acc-history-row"
                      disabled={busy}
                      onClick={() => open(row)}
                      aria-label={t(`继续观看 ${row.series_title} 第${row.vid_index}集`)}
                    >
                      <span className="acc-history-cover">
                        {row.cover && <img src={row.cover} alt="" loading="lazy" onError={event => event.currentTarget.remove()} />}
                        <Play size={16} />
                      </span>
                      <span className="acc-history-info">
                        <strong>{row.series_title}</strong>
                        <small>
                          {t("看到第 ")}{row.vid_index || '?'}{t(" 集")}{row.total ? ` / ${t("共 ")}${row.total}${t(" 集")}` : ''}
                          {' · '}
                          {Math.floor(row.currentTime || 0)}:{String(Math.floor((row.currentTime || 0) % 60)).padStart(2, '0')}
                        </small>
                        <small>{row.updatedAt ? new Date(row.updatedAt).toLocaleString(getLanguage(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : t('时间未知')}</small>
                      </span>
                      <span className="btn btn-outline btn-sm acc-history-play"><Play size={13} /><span>{t("继续观看")}</span></span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}

      {/* 6 & 7. Compact Accordions */}
      <div className="acc-accordions">
        {!account && (
          <details className="acc-accordion">
            <summary>
              <span>{t("如何扫码登录？")}</span>
              <ChevronDown size={16} />
            </summary>
            <div className="acc-steps-grid">
              <div className="acc-step-item">
                <span className="acc-step-num">1</span>
                <p>{t("打开手机红果 App")}</p>
              </div>
              <div className="acc-step-item">
                <span className="acc-step-num">2</span>
                <p>{t("扫描上方二维码")}</p>
              </div>
              <div className="acc-step-item">
                <span className="acc-step-num">3</span>
                <p>{t("在手机上确认登录")}</p>
              </div>
            </div>
          </details>
        )}

        <details className="acc-accordion">
          <summary>
            <span>{t("账号与隐私")}</span>
            <ChevronDown size={16} />
          </summary>
          <div className="acc-privacy-body">
            <p>{t("登录态由系统安全存储加密，普通资料备份不会包含账号凭据。")}</p>
            <p>{t("手机提示二维码无效时，可打开官网并使用官网当前提供的登录方式。")}</p>
            <p>{t("退出账号仅清除本机登录态，本机观看记录与下载文件不受影响。")}</p>
          </div>
        </details>
      </div>
    </div>
  );
}

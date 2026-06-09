/* global chrome */
(function () {
  'use strict';

  const el = {
    statusBadge: document.getElementById('statusBadge'),
    extensionStatus: document.getElementById('extensionStatus'),
    nativeStatus: document.getElementById('nativeStatus'),
    mcpStatus: document.getElementById('mcpStatus'),
    browserStatus: document.getElementById('browserStatus'),
    extensionId: document.getElementById('extensionId'),
    errorSection: document.getElementById('errorSection'),
    errorCode: document.getElementById('errorCode'),
    errorMessage: document.getElementById('errorMessage'),
    errorHint: document.getElementById('errorHint'),
    btnRefresh: document.getElementById('btnRefresh'),
    btnCopyDoctor: document.getElementById('btnCopyDoctor'),
    btnCopyInstall: document.getElementById('btnCopyInstall'),
    btnCopyMcpConfig: document.getElementById('btnCopyMcpConfig'),
  };

  function setStatus(selector, ok, text) {
    const cell = document.querySelector(selector);
    if (!cell) return;
    cell.textContent = text;
    cell.className = 'value ' + (ok ? 'ok' : 'bad');
  }

  function setBadge(text, cls) {
    el.statusBadge.textContent = text;
    el.statusBadge.className = 'badge ' + cls;
  }

  function localizeOverallStatus(status) {
    if (status === 'Ready') return '准备就绪';
    if (status === 'Checking') return '检查中';
    return '需要处理';
  }

  async function refresh() {
    setBadge('检查中', 'checking');

    let data;
    try {
      const response = await chrome.runtime.sendMessage({ method: 'health_check' });
      data = response?.result || response || { overallStatus: 'Action required', extensionLoaded: false };
    } catch (e) {
      data = {
        overallStatus: 'Action required',
        extensionLoaded: true,
        lastError: {
          code: 'POPUP_SEND_FAILED',
          message: e.message || '弹窗无法联系后台服务。',
          hint: '请在扩展管理页确认后台 Service Worker 正在运行，然后重新打开弹窗。'
        }
      };
    }

    const ok = data.overallStatus === 'Ready';
    setBadge(localizeOverallStatus(data.overallStatus), ok ? 'ready' : 'action-required');

    setStatus('[data-key="extension"] .value', true, data.extensionLoaded ? '已加载' : '未加载');
    el.extensionId.textContent = data.extensionId || chrome.runtime.id;

    const nh = data.nativeHost || {};
    const nativeConnected = nh.connected || nh.status === 'connected';
    setStatus('[data-key="nativeHost"] .value', nativeConnected, nativeConnected ? '已连接' : '未连接');

    const mcp = data.mcpServer || {};
    setStatus('[data-key="mcpServer"] .value', mcp.connected || false, mcp.connected ? '已连接' : (nativeConnected ? '可通过原生主机连接' : '未知'));

    const ba = data.browserAccess || {};
    const browserOk = ba.ok || false;
    const browserText = browserOk ? `可访问（窗口 ${ba.windowCount ?? 0} / 标签页 ${ba.tabCount ?? 0}）` : '未检测到可访问标签页';
    setStatus('[data-key="browserAccess"] .value', browserOk, browserText);

    const err = data.lastError;
    if (err && err.code) {
      el.errorSection.style.display = 'block';
      el.errorCode.textContent = err.code;
      el.errorMessage.textContent = err.message || '未提供错误消息';
      el.errorHint.textContent = err.hint || '请运行 health_check 或重新安装原生主机后再试。';
    } else {
      el.errorSection.style.display = 'none';
    }
  }

  async function copyText(text, button) {
    const originalText = button?.textContent;
    try {
      await navigator.clipboard.writeText(text);
      if (button) button.textContent = '复制成功';
    } catch (e) {
      if (button) button.textContent = '复制失败';
    } finally {
      if (button && originalText) {
        setTimeout(() => {
          button.textContent = originalText;
        }, 1200);
      }
    }
  }

  el.btnRefresh.addEventListener('click', refresh);

  el.btnCopyDoctor.addEventListener('click', function () {
    const extId = chrome.runtime.id;
    copyText(
      '检查扩展: chrome://extensions/?id=' + extId + '\n' +
      '重新加载扩展: chrome://extensions\n' +
      '检查安装: ./install.sh ' + extId + '\n' +
      '原生主机入口: host/native-host.js',
      el.btnCopyDoctor
    );
  });

  el.btnCopyInstall.addEventListener('click', function () {
    copyText('./install.sh ' + chrome.runtime.id, el.btnCopyInstall);
  });

  el.btnCopyMcpConfig.addEventListener('click', function () {
    copyText(JSON.stringify({
      mcpServers: {
        'browserpilot-mcp': {
          command: 'node',
          args: ['host/mcp-server.js'],
        },
      },
    }, null, 2), el.btnCopyMcpConfig);
  });

  refresh();
})();

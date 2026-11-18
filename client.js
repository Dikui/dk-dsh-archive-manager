/**
 * Client half of dk-dsh-archive-manager.
 *
 * A dedicated archive-center panel registered into the native `main` keyed
 * slot and the `sidebar.panellist` entry list. It reads the Host's archived
 * set through same-origin JSON routes and never asks the Client workspace
 * service to open an archived session. Restoring is always explicit; the
 * preview itself is read-only.
 *
 * @module dk-dsh-archive-manager/client
 */
window.__ModuleLoader__.load({
  id: 'dk-dsh-archive-manager',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    /** Locale namespace and panel id. */
    const NS = 'dk-dsh-archive-manager'
    /** Native panel id, shared by `main` and `sidebar.panellist`. */
    const ID = 'archive-manager'
    /** Host route prefix. */
    const BASE = '/api/dk-dsh-archive-manager'

    const messages = {
      en: {
        title: 'Archive Manager',
        subtitle: 'Browse, annotate, preview, and restore archived sessions',
        refresh: 'Refresh',
        searchPlaceholder: 'Search title, workspace, note, tag, or id',
        filterAll: 'All',
        filterNoted: 'With note',
        filterTagged: 'Tagged',
        filterUnknown: 'Unknown time',
        filterGhost: 'Missing log',
        sortArchivedDesc: 'Newest archived',
        sortArchivedAsc: 'Oldest archived',
        sortActiveDesc: 'Recently active',
        sortSizeDesc: 'Largest log',
        sortTitle: 'Title',
        statArchived: 'Archived',
        statSize: 'Log size',
        statUnknownTime: 'Unknown time',
        statLastArchived: 'Latest archive',
        sizeNote: 'Session logs only; attachments are not counted.',
        selectAll: 'Select all',
        selectedCount: 'selected',
        restore: 'Restore',
        restoreSelected: 'Restore selected',
        export: 'Export',
        exportSelected: 'Export selected',
        loading: 'Loading…',
        loadFailed: 'Could not load the archive',
        retry: 'Retry',
        emptyTitle: 'No archived sessions yet',
        emptyDesc: 'Archive a session from its “…” menu and it will appear here.',
        emptyNote: 'Archiving hides a session; it never deletes its log.',
        noMatch: 'No sessions match this view',
        clearFilters: 'Clear filters',
        unknownTitle: 'Untitled session',
        unfiled: 'No workspace',
        unknownTime: 'Unknown',
        archivedAtUnknown: 'Archive time unknown',
        ghost: 'Missing log',
        ghostHint: 'The archive set still holds this id, but its log file is gone.',
        createdAt: 'Created',
        archivedAt: 'Archived',
        lastActive: 'Last activity',
        size: 'Log size',
        workspace: 'Workspace',
        sessionId: 'Session ID',
        turns: 'Turns',
        steps: 'Steps',
        toolCalls: 'Tool calls',
        events: 'Events',
        firstUser: 'First user message',
        lastAssistant: 'Latest assistant reply',
        topTools: 'Tool calls',
        noText: 'No visible text',
        note: 'Note',
        notePlaceholder: 'A note for your future self…',
        tags: 'Tags',
        tagsPlaceholder: 'Comma separated, e.g. client, review',
        save: 'Save',
        saving: 'Saving…',
        saved: 'Note saved',
        saveFailed: 'Could not save the note',
        preview: 'Archived session',
        previewLoading: 'Reading a read-only preview…',
        previewFailed: 'Could not load the preview',
        close: 'Close',
        copy: 'Copy',
        copied: 'Copied',
        restoreDone: 'Restored. The archive center has been refreshed.',
        restoreFailed: 'Could not restore this session',
        partialRestore: 'Some sessions could not be restored',
        exportStarted: 'Export started',
        exportHint: 'The browser may block multiple downloads. Allow them and retry.',
        downloadZip: 'Export ZIP',
        requestFailed: 'Request failed',
        clearTag: 'Clear tag filter',
        selected: 'Selected',
        unknownSize: 'Unknown size',
        reasonInvalidRequest: 'The request was rejected',
        reasonForbidden: 'The request was rejected',
        reasonBodyTooLarge: 'The request was too large',
        reasonNotArchived: 'That session is not archived',
        reasonNotFound: 'The session log was not found',
        reasonReadFailed: 'Could not read the session',
        reasonListFailed: 'Could not load the archive',
        reasonUnarchiveFailed: 'Could not restore the session',
        reasonSaveFailed: 'Could not save the note',
        reasonMethodNotAllowed: 'The request was rejected',
        views: 'Views',
        allViews: 'All views',
        saveView: 'Save view',
        deleteView: 'Delete view',
        viewName: 'View name',
        viewNamePlaceholder: 'e.g. Client reviews',
        viewSaved: 'View saved',
        viewDeleted: 'View deleted',
        viewSaveFailed: 'Could not save the view',
        viewDeleteFailed: 'Could not delete the view',
        batchArchive: 'Batch workspace',
        batchTitle: 'Archive sessions',
        batchDesc: 'Filter sessions by time, choose exactly what to change, then archive or restore them in one step. Active sessions still require explicit confirmation before anything is stopped.',
        tabArchive: 'Archive library',
        tabBatch: 'Batch workspace',
        timeRange: 'Time range',
        rangeAll: 'All time',
        range24h: 'Past 24 hours',
        range7d: 'Past 7 days',
        range30d: 'Past 30 days',
        range90d: 'Past 90 days',
        timeBasis: 'Time basis',
        basisActivity: 'Last activity',
        basisCreated: 'Created',
        batchState: 'Session state',
        batchStateOpen: 'To archive',
        batchStateArchived: 'Archived',
        batchStateAll: 'All',
        batchSearchPlaceholder: 'Search loaded sessions',
        batchSortRecent: 'Recently active',
        batchSortCreated: 'Newest created',
        batchSortTitle: 'Title',
        batchLoaded: 'Matching',
        batchOpenSelected: 'to archive',
        batchArchivedSelected: 'to restore',
        batchClearSelection: 'Clear selection',
        batchTruncated: 'Only the first 200 open and 100 archived sessions are listed. Narrow the time range to see the rest.',
        batchEmptyTitle: 'No sessions match these filters',
        batchEmptyHint: 'Try a wider time range, or show both open and archived sessions.',
        batchUseAllTime: 'Use all time',
        batchUseAllStates: 'Show all sessions',
        batchRestored: 'Restored',
        batchActiveWarn: 'These sessions are doing work. Confirm that stopping their activity is okay.',
        candidateLoading: 'Loading sessions…',
        candidateEmpty: 'No sessions are available to archive',
        candidateArchived: 'Archived',
        candidateActive: 'Active',
        candidateActiveHint: 'This session is doing work',
        candidateIdle: 'Idle',
        archiveSelected: 'Archive selected',
        stopAndArchive: 'Stop activity and archive',
        confirmStop: 'I understand this stops the listed activity and archives the session.',
        activity: 'Activity',
        batchFailed: 'Some sessions could not be archived',
        batchArchived: 'Archived',
        notFound: 'Session not found',
        archiveNoticeHint: 'Archived. Open Archive Manager to see the archive time, note, and tags.',
        restoreOpenHint: 'Restored. Open it from the session list.',
        transcript: 'Full transcript',
        loadTranscript: 'Load transcript',
        transcriptLoading: 'Loading transcript…',
        transcriptFailed: 'Could not load the transcript',
        transcriptEmpty: 'No visible events',
        prevPage: 'Previous',
        nextPage: 'Next',
        pageInfo: 'Page',
        of: 'of',
        truncated: 'truncated',
        audit: 'History',
        auditArchived: 'Archived',
        auditRestored: 'Restored',
        auditSourceUser: 'by you',
        auditSourcePlugin: 'observed',
        auditSourceSystem: 'system',
        restoredAt: 'Restored',
        notRestored: 'Not restored',
        reasonConfirmationRequired: 'Confirmation is required',
        reasonTooManyViews: 'Too many saved views',
        reasonArchiveFailed: 'Could not archive the session',
      },
      zh: {
        title: '归档管理',
        subtitle: '浏览、整理、预览和恢复已归档会话',
        refresh: '刷新',
        searchPlaceholder: '搜索标题、工作区、备注、标签或 ID',
        filterAll: '全部',
        filterNoted: '有备注',
        filterTagged: '有标签',
        filterUnknown: '时间未知',
        filterGhost: '日志缺失',
        sortArchivedDesc: '最近归档',
        sortArchivedAsc: '最早归档',
        sortActiveDesc: '最近活动',
        sortSizeDesc: '日志最大',
        sortTitle: '按标题',
        statArchived: '归档会话',
        statSize: '日志大小',
        statUnknownTime: '时间未知',
        statLastArchived: '最近归档',
        sizeNote: '仅统计会话日志，不含附件。',
        selectAll: '全选',
        selectedCount: '项已选',
        restore: '恢复',
        restoreSelected: '恢复所选',
        export: '导出',
        exportSelected: '导出所选',
        loading: '正在加载…',
        loadFailed: '无法加载归档列表',
        retry: '重试',
        emptyTitle: '还没有归档会话',
        emptyDesc: '在侧栏会话的“…”菜单中归档后，会出现在这里。',
        emptyNote: '归档只是隐藏会话，不会删除日志。',
        noMatch: '没有匹配的会话',
        clearFilters: '清除筛选',
        unknownTitle: '未命名会话',
        unfiled: '未分组',
        unknownTime: '未知',
        archivedAtUnknown: '归档时间未知',
        ghost: '日志缺失',
        ghostHint: '归档集合中仍保留该 ID，但本地日志文件已不存在。',
        createdAt: '创建于',
        archivedAt: '归档于',
        lastActive: '最后活动',
        size: '日志大小',
        workspace: '工作区',
        sessionId: '会话 ID',
        turns: '轮次',
        steps: '步骤',
        toolCalls: '工具调用',
        events: '事件',
        firstUser: '首条用户消息',
        lastAssistant: '最近助手回复',
        topTools: '工具调用',
        noText: '没有可显示的文本',
        note: '备注',
        notePlaceholder: '给未来的自己留个说明…',
        tags: '标签',
        tagsPlaceholder: '用逗号分隔，例如：客户、复盘',
        save: '保存',
        saving: '保存中…',
        saved: '备注已保存',
        saveFailed: '备注保存失败',
        preview: '归档会话',
        previewLoading: '正在读取只读预览…',
        previewFailed: '预览加载失败',
        close: '关闭',
        copy: '复制',
        copied: '已复制',
        restoreDone: '已恢复，归档中心已刷新。',
        restoreFailed: '恢复这个会话失败',
        partialRestore: '部分会话恢复失败',
        exportStarted: '已开始导出',
        exportHint: '浏览器可能拦截多个下载，请允许后重试。',
        downloadZip: '导出 ZIP',
        requestFailed: '请求失败',
        clearTag: '清除标签筛选',
        selected: '已选',
        unknownSize: '大小未知',
        reasonInvalidRequest: '请求无效',
        reasonForbidden: '请求被拒绝',
        reasonBodyTooLarge: '请求过大',
        reasonNotArchived: '该会话不在归档集合中',
        reasonNotFound: '找不到会话日志',
        reasonReadFailed: '读取会话失败',
        reasonListFailed: '加载归档列表失败',
        reasonUnarchiveFailed: '恢复失败',
        reasonSaveFailed: '保存失败',
        reasonMethodNotAllowed: '请求被拒绝',
        views: '视图',
        allViews: '全部视图',
        saveView: '保存视图',
        deleteView: '删除视图',
        viewName: '视图名称',
        viewNamePlaceholder: '例如：客户复盘',
        viewSaved: '视图已保存',
        viewDeleted: '视图已删除',
        viewSaveFailed: '视图保存失败',
        viewDeleteFailed: '视图删除失败',
        batchArchive: '批量工作台',
        batchTitle: '归档会话',
        batchDesc: '按时间筛选会话，明确勾选要处理的项，再一步完成归档或恢复。活动中的会话仍需显式确认后才会停止。',
        tabArchive: '归档库',
        tabBatch: '批量工作台',
        timeRange: '时间范围',
        rangeAll: '全部时间',
        range24h: '过去 24 小时',
        range7d: '过去 7 天',
        range30d: '过去 30 天',
        range90d: '过去 90 天',
        timeBasis: '时间依据',
        basisActivity: '最后活动',
        basisCreated: '创建时间',
        batchState: '会话状态',
        batchStateOpen: '待归档',
        batchStateArchived: '已归档',
        batchStateAll: '全部',
        batchSearchPlaceholder: '搜索已加载会话',
        batchSortRecent: '最近活动',
        batchSortCreated: '最新创建',
        batchSortTitle: '按标题',
        batchLoaded: '匹配',
        batchOpenSelected: '待归档',
        batchArchivedSelected: '待恢复',
        batchClearSelection: '清空选择',
        batchTruncated: '受上限限制，仅显示前 200 个待归档和 100 个已归档会话；可缩小时间范围查看其余会话。',
        batchEmptyTitle: '当前筛选没有会话',
        batchEmptyHint: '试试扩大时间范围，或切换为全部状态。',
        batchUseAllTime: '使用全部时间',
        batchUseAllStates: '查看全部会话',
        batchRestored: '已恢复',
        batchActiveWarn: '这些会话正在执行任务，请确认可以停止其活动。',
        candidateLoading: '正在加载会话…',
        candidateEmpty: '没有可归档的会话',
        candidateArchived: '已归档',
        candidateActive: '活动中',
        candidateActiveHint: '该会话正在执行任务',
        candidateIdle: '空闲',
        archiveSelected: '归档所选',
        stopAndArchive: '停止活动并归档',
        confirmStop: '我确认停止下列活动并归档该会话。',
        activity: '活动',
        batchFailed: '部分会话归档失败',
        batchArchived: '已归档',
        notFound: '找不到会话',
        archiveNoticeHint: '已归档。打开“归档管理”可查看归档时间、备注和标签。',
        restoreOpenHint: '已恢复，请在会话列表打开。',
        transcript: '完整转录',
        loadTranscript: '加载转录',
        transcriptLoading: '正在加载转录…',
        transcriptFailed: '转录加载失败',
        transcriptEmpty: '没有可显示的事件',
        prevPage: '上一页',
        nextPage: '下一页',
        pageInfo: '第',
        of: '/',
        truncated: '已截断',
        audit: '操作历史',
        auditArchived: '归档',
        auditRestored: '恢复',
        auditSourceUser: '由你操作',
        auditSourcePlugin: '自动记录',
        auditSourceSystem: '系统',
        restoredAt: '恢复于',
        notRestored: '未恢复',
        reasonConfirmationRequired: '需要确认停止活动',
        reasonTooManyViews: '保存的视图过多',
        reasonArchiveFailed: '归档会话失败',
      },
    }

    const CSS = `
.dkam-root{--dkam-border:var(--dsw-alias-border-l2,rgba(127,127,127,.22));--dkam-border-strong:var(--dsw-alias-border-l1,rgba(127,127,127,.36));--dkam-bg:var(--dsw-alias-bg-base,#fff);--dkam-layer:var(--dsw-alias-bg-layer-1,#fff);--dkam-layer-2:var(--dsw-alias-bg-layer-2,#f5f6f8);--dkam-text:var(--dsw-alias-label-primary,#1f2328);--dkam-muted:var(--dsw-alias-label-secondary,#656d76);--dkam-faint:var(--dsw-alias-label-tertiary,#8b949e);--dkam-brand:var(--dsw-alias-brand-primary,#247bbf);--dkam-brand-soft:var(--dsw-alias-brand-primary-soft,rgba(36,123,191,.1));--dkam-hover:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1));--dkam-danger:var(--dsw-alias-state-error-primary,#d64545);--dkam-radius:var(--dsw-radius-lg,12px);display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;background:var(--dkam-bg);color:var(--dkam-text);font-size:14px;line-height:1.45;font-family:inherit}
.dkam-root *{box-sizing:border-box}
.dkam-head{flex:0 0 auto;padding:22px 26px 14px;border-bottom:1px solid var(--dkam-border);background:linear-gradient(180deg,var(--dkam-layer),var(--dkam-bg))}
.dkam-head-row{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}
.dkam-head-copy h1{margin:0;font-size:20px;font-weight:650;letter-spacing:-.01em}
.dkam-head-copy p{margin:5px 0 0;color:var(--dkam-muted);font-size:13px}
.dkam-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-top:18px}
.dkam-stat{min-width:0;padding:11px 13px;border:1px solid var(--dkam-border);border-radius:10px;background:var(--dkam-layer)}
.dkam-stat strong{display:block;font-size:18px;line-height:1.2;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dkam-stat span{display:block;margin-top:3px;color:var(--dkam-muted);font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dkam-size-note{margin-top:8px;color:var(--dkam-faint);font-size:11.5px}
.dkam-toolbar{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-top:16px}
.dkam-search{position:relative;flex:1 1 260px;max-width:400px;display:flex;align-items:center}
.dkam-search svg{position:absolute;left:10px;color:var(--dkam-faint);pointer-events:none}
.dkam-search input{width:100%;height:34px;padding:0 12px 0 32px;border:1px solid var(--dkam-border);border-radius:8px;background:var(--dkam-layer);color:var(--dkam-text);font:inherit;font-size:13px;outline:none}
.dkam-search input:focus,.dkam-select:focus,.dkam-field input:focus,.dkam-field textarea:focus{border-color:var(--dkam-brand);box-shadow:0 0 0 3px var(--dkam-brand-soft)}
.dkam-select{height:34px;max-width:180px;padding:0 28px 0 10px;border:1px solid var(--dkam-border);border-radius:8px;background:var(--dkam-layer);color:var(--dkam-text);font:inherit;font-size:12.5px;outline:none;cursor:pointer}
.dkam-toolbar-actions{display:flex;align-items:center;gap:6px;margin-left:auto;flex-wrap:wrap}
.dkam-btn{display:inline-flex;align-items:center;justify-content:center;gap:5px;height:32px;padding:0 11px;border:1px solid var(--dkam-border);border-radius:8px;background:var(--dkam-layer);color:var(--dkam-text);font:inherit;font-size:12.5px;font-weight:500;cursor:pointer;white-space:nowrap}
.dkam-btn:hover:not(:disabled){background:var(--dkam-hover);border-color:var(--dkam-border-strong)}
.dkam-btn:disabled{opacity:.45;cursor:default}
.dkam-btn-primary{border-color:transparent;background:var(--dkam-brand);color:var(--dkam-label-inverted,#fff)}
.dkam-btn-primary:hover:not(:disabled){filter:brightness(1.06);background:var(--dkam-brand)}
.dkam-btn-quiet{border-color:transparent;background:transparent;color:var(--dkam-muted)}
.dkam-btn-quiet:hover:not(:disabled){background:var(--dkam-hover);color:var(--dkam-text)}
.dkam-check{display:inline-flex;align-items:center;gap:6px;color:var(--dkam-muted);font-size:12.5px;cursor:pointer;user-select:none}
.dkam-check input{width:15px;height:15px;margin:0;accent-color:var(--dkam-brand)}
.dkam-selected{margin-left:2px;color:var(--dkam-faint);font-size:12px;white-space:nowrap}
.dkam-active-filter{display:flex;align-items:center;gap:8px;margin-top:10px;font-size:12.5px;color:var(--dkam-muted)}
.dkam-active-filter button{border:none;background:transparent;color:var(--dkam-brand);font:inherit;font-size:12.5px;cursor:pointer;padding:0}
.dkam-scroll{flex:1 1 auto;min-height:0;overflow:auto;padding:14px 26px 40px}
.dkam-list{display:flex;flex-direction:column;gap:8px}
.dkam-row{display:grid;grid-template-columns:22px minmax(0,1fr) 148px auto;align-items:center;gap:12px;padding:12px 14px;border:1px solid var(--dkam-border);border-radius:10px;background:var(--dkam-layer);transition:border-color .12s ease,background .12s ease}
.dkam-row:hover{border-color:var(--dkam-border-strong);background:var(--dkam-layer-2)}
.dkam-row[data-selected='true']{border-color:var(--dkam-brand);background:var(--dkam-brand-soft)}
.dkam-row>input[type='checkbox']{width:15px;height:15px;margin:0;accent-color:var(--dkam-brand)}
.dkam-row-body{min-width:0;cursor:pointer;outline:none}
.dkam-row-body:focus-visible{outline:2px solid var(--dkam-brand);outline-offset:3px;border-radius:4px}
.dkam-row-title-line{display:flex;align-items:center;gap:7px;min-width:0}
.dkam-row-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;font-weight:600}
.dkam-row-sub{display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin-top:3px;color:var(--dkam-muted);font-size:12px}
.dkam-dot{color:var(--dkam-faint)}
.dkam-row-note{display:block;margin-top:5px;color:var(--dkam-muted);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dkam-row-tags{display:flex;align-items:center;flex-wrap:wrap;gap:4px;margin-top:6px}
.dkam-tag{display:inline-flex;align-items:center;max-width:180px;height:19px;padding:0 7px;border:1px solid var(--dkam-border);border-radius:999px;background:var(--dkam-layer-2);color:var(--dkam-muted);font:inherit;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer}
.dkam-tag:hover{border-color:var(--dkam-brand);color:var(--dkam-brand)}
.dkam-pill{display:inline-flex;align-items:center;height:18px;padding:0 6px;border-radius:5px;background:var(--dkam-layer-2);color:var(--dkam-faint);font-size:10.5px;font-weight:500;white-space:nowrap}
.dkam-pill-warn{background:var(--dsw-alias-state-warn-soft,rgba(210,153,34,.14));color:var(--dsw-alias-state-warn-primary,#9a6700)}
.dkam-row-meta{display:flex;flex-direction:column;align-items:flex-end;gap:3px;min-width:0;color:var(--dkam-faint);font-size:11.5px;white-space:nowrap}
.dkam-row-actions{display:flex;align-items:center;gap:4px}
.dkam-row-actions .dkam-btn{height:28px;padding:0 9px;font-size:12px}
.dkam-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:72px 24px;text-align:center;color:var(--dkam-muted)}
.dkam-empty svg{color:var(--dkam-faint);opacity:.8}
.dkam-empty h2{margin:4px 0 0;font-size:16px;font-weight:600;color:var(--dkam-text)}
.dkam-empty p{margin:0;max-width:420px;font-size:13px}
.dkam-empty .dkam-btn{margin-top:8px}
.dkam-error{color:var(--dkam-danger)}
.dkam-skeleton{height:78px;border:1px solid var(--dkam-border);border-radius:10px;background:linear-gradient(90deg,var(--dkam-layer) 25%,var(--dkam-layer-2) 37%,var(--dkam-layer) 63%);background-size:400% 100%;animation:dkam-shimmer 1.35s ease infinite}
@keyframes dkam-shimmer{0%{background-position:100% 50%}100%{background-position:0 50%}}
.dkam-dialog{width:min(900px,calc(100vw - 40px));max-height:min(86vh,900px);padding:0;border:1px solid var(--dkam-border-strong);border-radius:16px;background:var(--dkam-layer);color:var(--dkam-text);box-shadow:0 30px 100px var(--dsw-alias-bg-mask-1,rgba(0,0,0,.45));font-family:inherit;font-size:14px}
.dkam-dialog[open]{display:flex;flex-direction:column}
.dkam-dialog::backdrop{background:var(--dsw-alias-bg-mask-3,rgba(0,0,0,.5))}
.dkam-dialog-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;padding:20px 24px 12px;border-bottom:1px solid var(--dkam-border)}
.dkam-dialog-title{margin:0;font-size:17px;font-weight:650;line-height:1.3}
.dkam-dialog-sub{margin:4px 0 0;color:var(--dkam-faint);font-size:12px;word-break:break-all}
.dkam-x{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;flex:0 0 auto;border:none;border-radius:7px;background:transparent;color:var(--dkam-muted);font-size:20px;line-height:1;cursor:pointer}
.dkam-x:hover{background:var(--dkam-hover);color:var(--dkam-text)}
.dkam-dialog-body{flex:1 1 auto;min-height:0;overflow:auto;padding:18px 24px 20px;display:flex;flex-direction:column;gap:18px}
.dkam-dialog-foot{display:flex;justify-content:flex-end;gap:8px;padding:14px 24px 18px;border-top:1px solid var(--dkam-border);flex-wrap:wrap}
.dkam-meta-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 22px}
.dkam-meta-item{min-width:0}
.dkam-meta-label{display:block;color:var(--dkam-faint);font-size:11px;letter-spacing:.02em;text-transform:uppercase}
.dkam-meta-value{margin-top:3px;font-size:13px;word-break:break-word}
.dkam-meta-value code{font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px}
.dkam-copy{border:none;background:transparent;color:var(--dkam-brand);font:inherit;font-size:11.5px;cursor:pointer;padding:0 0 0 6px}
.dkam-section{display:flex;flex-direction:column;gap:7px}
.dkam-section h3{margin:0;font-size:12px;font-weight:600;color:var(--dkam-muted)}
.dkam-excerpt{margin:0;padding:10px 12px;border:1px solid var(--dkam-border);border-radius:9px;background:var(--dkam-layer-2);color:var(--dkam-text);font:inherit;font-size:13px;line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere;max-height:180px;overflow:auto}
.dkam-excerpt-empty{color:var(--dkam-faint);font-style:italic}
.dkam-tool-list{display:flex;flex-wrap:wrap;gap:5px}
.dkam-tool{display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border:1px solid var(--dkam-border);border-radius:999px;background:var(--dkam-layer-2);color:var(--dkam-muted);font-size:11.5px}
.dkam-tool b{font-weight:600;color:var(--dkam-text)}
.dkam-editor{display:flex;flex-direction:column;gap:10px;padding-top:4px}
.dkam-field{display:flex;flex-direction:column;gap:5px}
.dkam-field>span{font-size:12px;font-weight:600;color:var(--dkam-muted)}
.dkam-field textarea,.dkam-field input{width:100%;padding:8px 10px;border:1px solid var(--dkam-border);border-radius:8px;background:var(--dkam-layer-2);color:var(--dkam-text);font:inherit;font-size:13px;outline:none}
.dkam-field textarea{min-height:76px;resize:vertical;line-height:1.5}
.dkam-editor-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px}
.dkam-hint{color:var(--dkam-faint);font-size:11.5px}
.dkam-toast{position:fixed;left:50%;bottom:28px;z-index:40;transform:translateX(-50%);max-width:min(560px,calc(100vw - 40px));padding:10px 16px;border:1px solid var(--dkam-border-strong);border-radius:999px;background:var(--dkam-layer);color:var(--dkam-text);box-shadow:0 12px 40px var(--dsw-alias-bg-mask-1,rgba(0,0,0,.24));font-size:13px;text-align:center}
.dkam-spinner{display:inline-block;width:14px;height:14px;border:2px solid var(--dkam-border);border-top-color:var(--dkam-brand);border-radius:50%;animation:dkam-spin .8s linear infinite}
@keyframes dkam-spin{to{transform:rotate(360deg)}}
@media (max-width:860px){.dkam-stats{grid-template-columns:repeat(2,minmax(0,1fr))}.dkam-row{grid-template-columns:22px minmax(0,1fr)}.dkam-row-meta{grid-column:2;flex-direction:row;align-items:center;gap:10px}.dkam-row-actions{grid-column:2;justify-content:flex-start}.dkam-toolbar-actions{margin-left:0}.dkam-head{padding:18px 18px 12px}.dkam-scroll{padding:12px 18px 32px}.dkam-batch-filters,.dkam-batch-bar,.dkam-batch-scroll,.dkam-batch-foot{padding-left:18px;padding-right:18px}.dkam-batch-warn{margin-left:18px;margin-right:18px}.dkam-batch-row{grid-template-columns:20px minmax(0,1fr)}.dkam-batch-side{display:none}}
@media (max-width:560px){.dkam-search{max-width:none;flex-basis:100%}.dkam-select{flex:1 1 0;max-width:none}.dkam-dialog{width:calc(100vw - 20px);max-height:92vh}.dkam-dialog-head,.dkam-dialog-body,.dkam-dialog-foot{padding-left:16px;padding-right:16px}.dkam-meta-grid{grid-template-columns:1fr}.dkam-head-row{flex-wrap:wrap}.dkam-head-actions{width:100%;justify-content:space-between}.dkam-tabs{flex:1 1 auto}.dkam-tab{flex:1}.dkam-batch .dkam-search{flex-basis:100%;max-width:none}.dkam-filter{flex:1 1 0}.dkam-filter .dkam-select{width:100%;max-width:none}.dkam-seg{width:100%}.dkam-seg button{flex:1}.dkam-batch-bar .dkam-select{margin-left:0;max-width:none;flex:1}.dkam-batch-foot{align-items:flex-start;flex-direction:column}.dkam-batch-actions{width:100%}.dkam-batch-actions .dkam-btn{flex:1}}
.dkam-viewbar{display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin-top:10px}
.dkam-viewbar .dkam-select{max-width:220px}
.dkam-view-editor{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:8px}
.dkam-view-editor input{height:32px;min-width:180px;padding:0 10px;border:1px solid var(--dkam-border);border-radius:8px;background:var(--dkam-layer-2);color:var(--dkam-text);font:inherit;font-size:12.5px;outline:none}
.dkam-head-actions{display:flex;align-items:center;gap:10px;flex:0 0 auto}
.dkam-tabs{display:inline-flex;gap:2px;padding:2px;border:1px solid var(--dkam-border);border-radius:9px;background:var(--dkam-layer-2)}
.dkam-tab{height:28px;padding:0 10px;border:none;border-radius:7px;background:transparent;color:var(--dkam-muted);font:inherit;font-size:12.5px;font-weight:500;cursor:pointer;white-space:nowrap}
.dkam-tab:hover{color:var(--dkam-text)}
.dkam-tab[data-active='true']{background:var(--dkam-layer);color:var(--dkam-text);box-shadow:0 1px 2px rgba(0,0,0,.08)}
.dkam-batch{flex:1 1 auto;min-height:0;overflow:hidden;display:flex;flex-direction:column}
.dkam-batch-filters{display:flex;align-items:flex-end;flex-wrap:wrap;gap:8px;padding:14px 26px;border-bottom:1px solid var(--dkam-border);background:var(--dkam-layer)}
.dkam-filter{display:flex;flex-direction:column;gap:3px;min-width:0}
.dkam-filter>span{color:var(--dkam-faint);font-size:10.5px;letter-spacing:.02em;text-transform:uppercase}
.dkam-filter .dkam-select{max-width:170px}
.dkam-batch .dkam-search{flex:1 1 240px;max-width:360px}
.dkam-seg{display:inline-flex;height:34px;padding:2px;border:1px solid var(--dkam-border);border-radius:8px;background:var(--dkam-layer-2)}
.dkam-seg button{height:28px;padding:0 10px;border:none;border-radius:6px;background:transparent;color:var(--dkam-muted);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}
.dkam-seg button[data-active='true']{background:var(--dkam-layer);color:var(--dkam-text);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.08)}
.dkam-batch-bar{display:flex;align-items:center;flex-wrap:wrap;gap:10px;padding:10px 26px;border-bottom:1px solid var(--dkam-border);color:var(--dkam-muted);font-size:12px}
.dkam-batch-bar .dkam-select{margin-left:auto;max-width:160px}
.dkam-batch-scroll{flex:1 1 auto;min-height:0;overflow:auto;padding:14px 26px 20px}
.dkam-batch-list{display:flex;flex-direction:column;gap:8px}
.dkam-batch-row{display:grid;grid-template-columns:20px minmax(0,1fr) auto;align-items:center;gap:12px;padding:11px 14px;border:1px solid var(--dkam-border);border-radius:10px;background:var(--dkam-layer)}
.dkam-batch-row:hover{border-color:var(--dkam-border-strong);background:var(--dkam-layer-2)}
.dkam-batch-row[data-selected='true']{border-color:var(--dkam-brand);background:var(--dkam-brand-soft)}
.dkam-batch-row>input{width:15px;height:15px;margin:0;accent-color:var(--dkam-brand)}
.dkam-batch-row-main{min-width:0;cursor:pointer}
.dkam-batch-row-title{display:flex;align-items:center;gap:7px;min-width:0}
.dkam-batch-title-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13.5px;font-weight:600}
.dkam-batch-row-sub{margin-top:3px;overflow:hidden;color:var(--dkam-muted);font-size:11.5px;text-overflow:ellipsis;white-space:nowrap}
.dkam-batch-row-activity{display:flex;flex-wrap:wrap;gap:4px;margin-top:5px}
.dkam-batch-side{color:var(--dkam-faint);font-size:11px;text-align:right;white-space:nowrap}
.dkam-batch-foot{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;padding:12px 26px;border-top:1px solid var(--dkam-border);background:linear-gradient(0deg,var(--dkam-layer),var(--dkam-bg))}
.dkam-batch-summary{display:flex;align-items:baseline;gap:5px;color:var(--dkam-muted);font-size:12px}
.dkam-batch-summary strong{color:var(--dkam-text);font-size:17px;font-weight:650}
.dkam-batch-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.dkam-batch-warn{margin:0 26px 10px}
.dkam-empty-actions{display:flex;justify-content:center;flex-wrap:wrap;gap:8px}
.dkam-candidate-list{display:flex;flex-direction:column;gap:6px;max-height:48vh;overflow:auto;padding-right:2px}
.dkam-candidate-row{display:grid;grid-template-columns:20px minmax(0,1fr) auto;align-items:center;gap:10px;padding:9px 11px;border:1px solid var(--dkam-border);border-radius:9px;background:var(--dkam-layer-2)}
.dkam-candidate-row[data-archived='true']{opacity:.62}
.dkam-candidate-main{min-width:0}
.dkam-candidate-title{display:flex;align-items:center;gap:6px;min-width:0;font-size:13px;font-weight:600}
.dkam-candidate-title span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dkam-candidate-sub{margin-top:2px;color:var(--dkam-muted);font-size:11.5px}
.dkam-candidate-activity{display:flex;flex-wrap:wrap;gap:4px;margin-top:5px}
.dkam-activity-chip{display:inline-flex;align-items:center;padding:1px 7px;border-radius:999px;background:var(--dsw-alias-state-warn-soft,rgba(210,153,34,.14));color:var(--dsw-alias-state-warn-primary,#9a6700);font-size:10.5px}
.dkam-warn-box{padding:10px 12px;border:1px solid var(--dsw-alias-state-warn-primary,#9a6700);border-radius:9px;background:var(--dsw-alias-state-warn-soft,rgba(210,153,34,.1))}
.dkam-warn-box h3{margin:0 0 4px;font-size:12.5px;color:var(--dkam-text)}
.dkam-warn-box p{margin:0;color:var(--dkam-muted);font-size:12px}
.dkam-warn-box ul{margin:6px 0 0;padding-left:18px;color:var(--dkam-muted);font-size:12px}
.dkam-transcript{display:flex;flex-direction:column;gap:6px;max-height:340px;overflow:auto;padding:2px}
.dkam-event{display:grid;grid-template-columns:112px minmax(0,1fr);gap:9px;padding:7px 9px;border:1px solid var(--dkam-border);border-radius:7px;background:var(--dkam-layer-2)}
.dkam-event-head{display:flex;flex-direction:column;gap:2px;color:var(--dkam-faint);font-size:10.5px;line-height:1.3}
.dkam-event-role{color:var(--dkam-muted);font-size:11px;font-weight:600}
.dkam-event-text{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;font-size:12px;line-height:1.45;max-height:150px;overflow:auto}
.dkam-pager{display:flex;align-items:center;gap:8px;justify-content:flex-end;margin-top:6px}
.dkam-pager span{color:var(--dkam-faint);font-size:11.5px}
.dkam-timeline{display:flex;flex-direction:column;gap:0;margin:0;padding:0;list-style:none}
.dkam-timeline li{position:relative;display:flex;gap:10px;padding:0 0 12px 16px;border-left:1px solid var(--dkam-border)}
.dkam-timeline li:last-child{padding-bottom:0;border-left-color:transparent}
.dkam-timeline li::before{content:'';position:absolute;left:-4px;top:3px;width:7px;height:7px;border-radius:50%;background:var(--dkam-brand)}
.dkam-timeline time{display:block;color:var(--dkam-faint);font-size:11px}
.dkam-timeline strong{display:block;font-size:12.5px;font-weight:600}
.dkam-timeline small{color:var(--dkam-muted);font-size:11px}
`

    /** Inject the panel stylesheet once. */
    function installStyles() {
      const existing = document.querySelector('style[data-dk-archive-manager]')
      if (existing) return () => {}
      const element = document.createElement('style')
      element.dataset.dkArchiveManager = '1'
      element.textContent = CSS
      document.head.appendChild(element)
      return () => element.remove()
    }

    /** Archive-box glyph used by the sidebar panel list and empty states. */
    function ArchiveIcon({ size = 16 }) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        'aria-hidden': 'true',
        style: { display: 'block' },
      },
        h('path', { d: 'M2.1 3.1h11.8v2.5H2.1z', stroke: 'currentColor', strokeWidth: 1.25, strokeLinejoin: 'round' }),
        h('path', { d: 'M3.2 5.6v7.3h9.6V5.6', stroke: 'currentColor', strokeWidth: 1.25, strokeLinejoin: 'round' }),
        h('path', { d: 'M6.1 8.2h3.8', stroke: 'currentColor', strokeWidth: 1.25, strokeLinecap: 'round' }),
      )
    }

    /** Small search glyph. */
    function SearchIcon() {
      return h('svg', { width: 15, height: 15, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('circle', { cx: 7, cy: 7, r: 4.2, stroke: 'currentColor', strokeWidth: 1.3 }),
        h('path', { d: 'm10.2 10.2 3 3', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
      )
    }

    /** Small refresh glyph. */
    function RefreshIcon() {
      return h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('path', { d: 'M13 6.2A5.4 5.4 0 1 0 13.1 10', stroke: 'currentColor', strokeWidth: 1.35, strokeLinecap: 'round' }),
        h('path', { d: 'M13 2.8v3.6H9.4', stroke: 'currentColor', strokeWidth: 1.35, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      )
    }

    /** Format a byte count for rows and summary cards. */
    function formatBytes(value) {
      if (!Number.isFinite(value) || value < 0) return '—'
      if (value < 1024) return `${Math.round(value)} B`
      const units = ['KB', 'MB', 'GB', 'TB']
      let size = value / 1024
      let unit = 0
      while (size >= 1024 && unit < units.length - 1) {
        size /= 1024
        unit += 1
      }
      return `${size >= 10 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`
    }

    /** Format an epoch timestamp, or an em dash when absent. */
    function formatTime(value) {
      if (!Number.isFinite(value) || value <= 0) return '—'
      try {
        return new Intl.DateTimeFormat(undefined, {
          year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
        }).format(new Date(value))
      } catch {
        return new Date(value).toLocaleString()
      }
    }

    /** Local view filter; mirrors src/model.js without a cross-file import. */
    function filterItems(items, options) {
      const query = String(options.query ?? '').trim().toLocaleLowerCase()
      const filter = options.filter ?? 'all'
      const tag = String(options.tag ?? '').trim().toLocaleLowerCase()
      const sort = options.sort ?? 'archived-desc'
      const filtered = (Array.isArray(items) ? items : []).filter(item => {
        if (filter === 'noted' && !item.note) return false
        if (filter === 'tagged' && !(Array.isArray(item.tags) && item.tags.length > 0)) return false
        if (filter === 'unknown' && item.archivedAt) return false
        if (filter === 'ghost' && item.ghost !== true) return false
        if (tag && !(Array.isArray(item.tags) && item.tags.some(value => String(value).toLocaleLowerCase() === tag))) return false
        if (query) {
          const haystack = [item.title, item.workspaceTitle, item.cwd, item.note,
            Array.isArray(item.tags) ? item.tags.join(' ') : '', item.sessionId]
            .filter(Boolean).join('\n').toLocaleLowerCase()
          if (!haystack.includes(query)) return false
        }
        return true
      })
      const num = (a, b) => (Number.isFinite(b) ? b : -Infinity) - (Number.isFinite(a) ? a : -Infinity)
      filtered.sort((a, b) => {
        switch (sort) {
          case 'archived-asc':
            return (a.archivedAt ?? Number.POSITIVE_INFINITY) - (b.archivedAt ?? Number.POSITIVE_INFINITY)
              || (b.createdAt ?? 0) - (a.createdAt ?? 0)
          case 'active-desc':
            return num(a.lastActivityAt, b.lastActivityAt) || num(a.createdAt, b.createdAt)
          case 'size-desc':
            return num(a.sizeBytes, b.sizeBytes) || num(a.createdAt, b.createdAt)
          case 'title':
            return String(a.title ?? '').localeCompare(String(b.title ?? ''), 'zh')
          case 'archived-desc':
          default:
            return (b.archivedAt ?? -Infinity) - (a.archivedAt ?? -Infinity)
              || (b.createdAt ?? 0) - (a.createdAt ?? 0)
        }
      })
      return filtered
    }

    /** Local batch-workspace filter; the server already applied time/state. */
    function filterBatchItems(items, options) {
      const query = String(options.query ?? '').trim().toLocaleLowerCase()
      const sort = options.sort ?? 'active-desc'
      const filtered = (Array.isArray(items) ? items : []).filter(item => {
        if (!query) return true
        const haystack = [item.title, item.workspaceTitle, item.cwd, item.sessionId]
          .filter(Boolean).join('\n').toLocaleLowerCase()
        return haystack.includes(query)
      })
      const timeOf = item => (Number.isFinite(item.lastActivityAt) ? item.lastActivityAt : item.createdAt)
      filtered.sort((a, b) => {
        switch (sort) {
          case 'created-desc':
            return (b.createdAt ?? 0) - (a.createdAt ?? 0)
          case 'title':
            return String(a.title ?? '').localeCompare(String(b.title ?? ''), 'zh')
          case 'active-desc':
          default:
            return (timeOf(b) ?? 0) - (timeOf(a) ?? 0)
              || (b.createdAt ?? 0) - (a.createdAt ?? 0)
        }
      })
      return filtered
    }

    /**
     * The archive center panel.
     * @param {{ tr: (key: string) => string }} props - Locale translator.
     * @returns {import('react').ReactElement} Panel.
     */
    function ArchivePanel({ tr }) {
      const [items, setItems] = useState([])
      const [summary, setSummary] = useState(null)
      const [loading, setLoading] = useState(true)
      const [loadError, setLoadError] = useState(null)
      const [reloadKey, setReloadKey] = useState(0)
      const [query, setQuery] = useState('')
      const [filter, setFilter] = useState('all')
      const [sort, setSort] = useState('archived-desc')
      const [tag, setTag] = useState('')
      const [selected, setSelected] = useState(() => new Set())
      const [preview, setPreview] = useState(null)
      const [noteDraft, setNoteDraft] = useState('')
      const [tagsDraft, setTagsDraft] = useState('')
      const [saving, setSaving] = useState(false)
      const [busy, setBusy] = useState('')
      const [notice, setNotice] = useState('')
      const [views, setViews] = useState([])
      const [viewId, setViewId] = useState('')
      const [viewEditorOpen, setViewEditorOpen] = useState(false)
      const [viewName, setViewName] = useState('')
      const [viewBusy, setViewBusy] = useState(false)
      const [mode, setMode] = useState('library')
      const [batchItems, setBatchItems] = useState(null)
      const [batchMeta, setBatchMeta] = useState(null)
      const [batchLoading, setBatchLoading] = useState(false)
      const [batchError, setBatchError] = useState(null)
      const [batchRange, setBatchRange] = useState('7d')
      const [batchBasis, setBatchBasis] = useState('activity')
      const [batchState, setBatchState] = useState('open')
      const [batchQuery, setBatchQuery] = useState('')
      const [batchSort, setBatchSort] = useState('active-desc')
      const [batchReloadKey, setBatchReloadKey] = useState(0)
      const [batchSelected, setBatchSelected] = useState(() => new Set())
      const [batchBusy, setBatchBusy] = useState(false)
      const [batchFailures, setBatchFailures] = useState([])
      const [batchConfirmStop, setBatchConfirmStop] = useState(false)
      const [transcript, setTranscript] = useState(null)
      const dialogRef = useRef(null)
      const noticeTimer = useRef(null)

      const reasonText = useCallback((reason) => {
        const map = {
          'invalid-request': 'reasonInvalidRequest',
          forbidden: 'reasonForbidden',
          'body-too-large': 'reasonBodyTooLarge',
          'not-archived': 'reasonNotArchived',
          'not-found': 'reasonNotFound',
          'read-failed': 'reasonReadFailed',
          'list-failed': 'reasonListFailed',
          'unarchive-failed': 'reasonUnarchiveFailed',
          'save-failed': 'reasonSaveFailed',
          'method-not-allowed': 'reasonMethodNotAllowed',
          'confirmation-required': 'reasonConfirmationRequired',
          'too-many-views': 'reasonTooManyViews',
          'archive-failed': 'reasonArchiveFailed',
        }
        return tr(map[reason] ?? 'requestFailed')
      }, [tr])

      const post = useCallback(async (name, body) => {
        let response
        try {
          response = await fetch(`${BASE}/${name}`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-dk-archive-manager': '1',
            },
            body: JSON.stringify(body ?? {}),
          })
        } catch {
          throw new Error(tr('requestFailed'))
        }
        let data = null
        try {
          data = await response.json()
        } catch {
          data = null
        }
        if (!response.ok) {
          const error = new Error(reasonText(data?.reason))
          error.reason = data?.reason
          throw error
        }
        return data ?? {}
      }, [reasonText, tr])

      useEffect(() => {
        let cancelled = false
        setLoading(true)
        setLoadError(null)
        post('list', {}).then(data => {
          if (cancelled) return
          setItems(Array.isArray(data.items) ? data.items : [])
          setSummary(data.summary ?? null)
          setLoading(false)
        }).catch(error => {
          if (cancelled) return
          setLoadError(error.message)
          setLoading(false)
        })
        return () => { cancelled = true }
      }, [reloadKey, post])

      useEffect(() => {
        setSelected(previous => {
          const live = new Set(items.map(item => item.sessionId))
          const next = new Set([...previous].filter(id => live.has(id)))
          return next.size === previous.size ? previous : next
        })
      }, [items])

      useEffect(() => {
        const dialog = dialogRef.current
        if (!dialog) return
        if (preview && !dialog.open) {
          try {
            dialog.showModal()
          } catch {
            dialog.setAttribute('open', '')
          }
        } else if (!preview && dialog.open) {
          dialog.close()
        }
      }, [preview])

      useEffect(() => {
        if (!notice) return undefined
        clearTimeout(noticeTimer.current)
        noticeTimer.current = setTimeout(() => setNotice(''), 4200)
        return () => clearTimeout(noticeTimer.current)
      }, [notice])

      const refreshViews = useCallback(async () => {
        const data = await post('views', {})
        setViews(Array.isArray(data.views) ? data.views : [])
      }, [post])

      useEffect(() => {
        refreshViews().catch(() => {})
      }, [refreshViews])

      useEffect(() => {
        if (mode !== 'batch') return undefined
        let cancelled = false
        setBatchLoading(true)
        setBatchError(null)
        post('candidates', { range: batchRange, basis: batchBasis, state: batchState })
          .then(data => {
            if (cancelled) return
            setBatchItems(Array.isArray(data.items) ? data.items : [])
            setBatchMeta({
              openTotal: Number.isFinite(data.openTotal) ? data.openTotal : 0,
              archivedTotal: Number.isFinite(data.archivedTotal) ? data.archivedTotal : 0,
              total: Number.isFinite(data.total) ? data.total : 0,
              truncatedOpen: data.truncatedOpen === true,
              truncatedArchived: data.truncatedArchived === true,
            })
            setBatchLoading(false)
          })
          .catch(error => {
            if (cancelled) return
            setBatchError(error.message || tr('loadFailed'))
            setBatchLoading(false)
          })
        return () => { cancelled = true }
      }, [mode, batchRange, batchBasis, batchState, batchReloadKey, post, tr])

      useEffect(() => {
        setBatchSelected(new Set())
        setBatchFailures([])
        setBatchConfirmStop(false)
      }, [batchRange, batchBasis, batchState])

      const filtered = useMemo(
        () => filterItems(items, { query, filter, tag, sort }),
        [items, query, filter, tag, sort],
      )

      const allSelected = filtered.length > 0 && filtered.every(item => selected.has(item.sessionId))
      const restorableSelected = [...selected].filter(id => items.some(item => item.sessionId === id && !item.ghost))

      const batchVisible = useMemo(
        () => filterBatchItems(batchItems ?? [], { query: batchQuery, sort: batchSort }),
        [batchItems, batchQuery, batchSort],
      )
      const batchAllSelected = batchVisible.length > 0
        && batchVisible.every(item => batchSelected.has(item.sessionId))
      const batchOpenSelected = (batchItems ?? []).filter(item => !item.archived && batchSelected.has(item.sessionId))
      const batchArchivedSelected = (batchItems ?? []).filter(item => item.archived && batchSelected.has(item.sessionId))
      const batchFailureIds = new Set(batchFailures.map(failure => failure.sessionId))
      const batchNeedsConfirm = batchOpenSelected.some(candidate => batchFailureIds.has(candidate.sessionId))

      useEffect(() => {
        setBatchSelected(previous => {
          const loaded = new Set((batchItems ?? []).map(item => item.sessionId))
          const next = new Set([...previous].filter(id => loaded.has(id)))
          return next.size === previous.size ? previous : next
        })
      }, [batchItems])

      const reload = () => setReloadKey(key => key + 1)

      const toggleAll = () => {
        setSelected(previous => {
          if (allSelected) {
            const next = new Set(previous)
            for (const item of filtered) next.delete(item.sessionId)
            return next
          }
          return new Set([...previous, ...filtered.map(item => item.sessionId)])
        })
      }

      const toggleOne = (sessionId) => {
        setSelected(previous => {
          const next = new Set(previous)
          if (next.has(sessionId)) next.delete(sessionId)
          else next.add(sessionId)
          return next
        })
      }

      const openPreview = (item) => {
        setPreview({ item, data: null, loading: true, error: null })
        setTranscript(null)
        setNoteDraft(item.note ?? '')
        setTagsDraft(Array.isArray(item.tags) ? item.tags.join(', ') : '')
        post('preview', { sessionId: item.sessionId }).then(data => {
          setPreview(previous => previous && previous.item.sessionId === item.sessionId
            ? { ...previous, loading: false, data: data.preview, error: null }
            : previous)
          setNoteDraft(data.preview?.note ?? '')
          setTagsDraft(Array.isArray(data.preview?.tags) ? data.preview.tags.join(', ') : '')
        }).catch(error => {
          setPreview(previous => previous && previous.item.sessionId === item.sessionId
            ? { ...previous, loading: false, error: error.message }
            : previous)
        })
      }

      const closePreview = () => {
        const dialog = dialogRef.current
        if (dialog?.open) dialog.close()
        else setPreview(null)
      }

      const saveNote = async () => {
        if (!preview?.item || saving) return
        setSaving(true)
        try {
          const data = await post('entry', {
            sessionId: preview.item.sessionId,
            note: noteDraft,
            tags: tagsDraft,
          })
          const entry = data.entry ?? {}
          setItems(previous => previous.map(item => item.sessionId === preview.item.sessionId
            ? {
              ...item,
              note: entry.note ?? null,
              tags: Array.isArray(entry.tags) ? entry.tags : [],
              archivedAt: entry.archivedAt ?? item.archivedAt,
              archivedAtKnown: entry.archivedAtKnown ?? item.archivedAtKnown,
              inferred: entry.inferred ?? item.inferred,
            }
            : item))
          setPreview(previous => previous
            ? { ...previous, data: { ...previous.data, ...entry } }
            : previous)
          setNotice(tr('saved'))
        } catch (error) {
          setNotice(error.message || tr('saveFailed'))
        } finally {
          setSaving(false)
        }
      }

      const restoreOne = async (item) => {
        if (busy) return
        setBusy(item.sessionId)
        try {
          const data = await post('unarchive', { sessionId: item.sessionId })
          if (data.ok === false) throw new Error(reasonText(data.reason))
          setNotice(tr('restoreOpenHint'))
          setPreview(null)
          reload()
        } catch (error) {
          setNotice(error.message || tr('restoreFailed'))
        } finally {
          setBusy('')
        }
      }

      const restoreSelected = async () => {
        if (busy || restorableSelected.length === 0) return
        setBusy('batch')
        try {
          const data = await post('unarchive-many', { sessionIds: restorableSelected })
          if (Array.isArray(data.failed) && data.failed.length > 0) {
            setNotice(`${tr('partialRestore')} (${data.failed.length})`)
          } else {
            setNotice(tr('restoreOpenHint'))
          }
          setSelected(new Set())
          setPreview(null)
          reload()
        } catch (error) {
          setNotice(error.message || tr('restoreFailed'))
        } finally {
          setBusy('')
        }
      }

      const exportSession = (sessionId) => {
        const anchor = document.createElement('a')
        anchor.href = `/api/session.export?sessionId=${encodeURIComponent(sessionId)}&includeDescendants=true`
        anchor.download = ''
        anchor.rel = 'noopener'
        document.body.appendChild(anchor)
        anchor.click()
        anchor.remove()
      }

      const exportSelected = () => {
        const chosen = items.filter(item => selected.has(item.sessionId) && !item.ghost)
        if (chosen.length === 0) return
        chosen.forEach((item, index) => {
          setTimeout(() => exportSession(item.sessionId), index * 350)
        })
        setNotice(`${tr('exportStarted')} · ${tr('exportHint')}`)
      }

      const copyId = async (sessionId) => {
        try {
          await navigator.clipboard.writeText(sessionId)
          setNotice(tr('copied'))
        } catch {
          setNotice(tr('requestFailed'))
        }
      }

      const loadTranscript = async (offset = 0) => {
        const sessionId = preview?.item?.sessionId
        if (!sessionId) return
        setTranscript({ loading: true, error: null, data: null })
        try {
          const result = await post('transcript', { sessionId, offset, limit: 40 })
          setTranscript({ loading: false, error: null, data: result.transcript })
        } catch (error) {
          setTranscript({ loading: false, error: error.message || tr('transcriptFailed'), data: null })
        }
      }

      const applyView = (id) => {
        setViewId(id)
        const view = views.find(candidate => candidate.id === id)
        if (!view) {
          if (id === '') {
            setQuery('')
            setFilter('all')
            setSort('archived-desc')
            setTag('')
          }
          return
        }
        setQuery(view.query ?? '')
        setFilter(view.filter ?? 'all')
        setSort(view.sort ?? 'archived-desc')
        setTag(view.tag ?? '')
      }

      const saveView = async () => {
        const name = viewName.trim()
        if (name.length === 0 || viewBusy) return
        setViewBusy(true)
        try {
          const data = await post('view-save', {
            id: viewId || undefined,
            name,
            query,
            filter,
            sort,
            tag,
          })
          const saved = data.view
          if (saved) {
            setViews(previous => {
              const rest = previous.filter(view => view.id !== saved.id)
              return [saved, ...rest]
            })
            setViewId(saved.id)
          }
          setViewEditorOpen(false)
          setViewName('')
          setNotice(tr('viewSaved'))
        } catch (error) {
          setNotice(error.message || tr('viewSaveFailed'))
        } finally {
          setViewBusy(false)
        }
      }

      const deleteView = async () => {
        if (!viewId || viewBusy) return
        setViewBusy(true)
        try {
          await post('view-delete', { id: viewId })
          setViews(previous => previous.filter(view => view.id !== viewId))
          setViewId('')
          setNotice(tr('viewDeleted'))
        } catch (error) {
          setNotice(error.message || tr('viewDeleteFailed'))
        } finally {
          setViewBusy(false)
        }
      }

      const reloadBatch = () => setBatchReloadKey(key => key + 1)

      const toggleBatchAll = () => {
        setBatchSelected(previous => {
          const next = new Set(previous)
          if (batchAllSelected) {
            for (const candidate of batchVisible) next.delete(candidate.sessionId)
          } else {
            for (const candidate of batchVisible) next.add(candidate.sessionId)
          }
          return next
        })
      }

      const toggleBatchOne = (sessionId) => {
        setBatchSelected(previous => {
          const next = new Set(previous)
          if (next.has(sessionId)) next.delete(sessionId)
          else next.add(sessionId)
          return next
        })
      }

      const clearBatchSelection = () => {
        setBatchSelected(new Set())
        setBatchFailures([])
        setBatchConfirmStop(false)
      }

      const archiveBatch = async (stopActivity) => {
        if (batchBusy) return
        const chosen = batchOpenSelected.map(candidate => candidate.sessionId)
        if (chosen.length === 0) return
        if (stopActivity && !batchConfirmStop) {
          setNotice(tr('reasonConfirmationRequired'))
          return
        }
        setBatchBusy(true)
        try {
          const body = { sessionIds: chosen }
          if (stopActivity) {
            body.stopActivity = true
            body.confirmStop = true
          }
          const data = await post('archive-many', body)
          const failed = Array.isArray(data.failed) ? data.failed : []
          const active = failed.filter(item => item.reason === 'active')
          const archived = Array.isArray(data.archived) ? data.archived : []
          setBatchFailures(active)
          setBatchSelected(new Set(active.map(failure => failure.sessionId)))
          if (failed.length === 0) {
            setBatchConfirmStop(false)
            setNotice(`${tr('batchArchived')} ${archived.length}`)
            reloadBatch()
          } else {
            setNotice(tr('batchFailed'))
          }
          reload()
        } catch (error) {
          setNotice(error.message || tr('batchFailed'))
        } finally {
          setBatchBusy(false)
        }
      }

      const restoreBatch = async () => {
        if (batchBusy) return
        const chosen = batchArchivedSelected.map(candidate => candidate.sessionId)
        if (chosen.length === 0) return
        setBatchBusy(true)
        try {
          const data = await post('unarchive-many', { sessionIds: chosen })
          const restored = Array.isArray(data.restored) ? data.restored : []
          const failed = Array.isArray(data.failed) ? data.failed : []
          setBatchFailures([])
          setBatchConfirmStop(false)
          setBatchSelected(new Set([
            ...batchOpenSelected.map(candidate => candidate.sessionId),
            ...failed.map(failure => failure.sessionId),
          ]))
          setNotice(failed.length === 0
            ? `${tr('batchRestored')} ${restored.length}`
            : tr('partialRestore'))
          reloadBatch()
          reload()
        } catch (error) {
          setNotice(error.message || tr('restoreFailed'))
        } finally {
          setBatchBusy(false)
        }
      }

      const exportBatch = () => {
        const chosen = (batchItems ?? []).filter(candidate => batchSelected.has(candidate.sessionId))
        if (chosen.length === 0) return
        chosen.forEach((candidate, index) => {
          setTimeout(() => exportSession(candidate.sessionId), index * 350)
        })
        setNotice(`${tr('exportStarted')} · ${tr('exportHint')}`)
      }

      const data = preview?.data
      const item = preview?.item
      const previewTitle = data?.title || item?.title || tr('unknownTitle')
      const totalSize = summary?.totalSize
      const knownSizes = summary?.knownSizeCount ?? 0
      const unknownSizes = summary?.unknownSizeCount ?? 0
      const latestArchived = summary?.latestArchivedAt
      const count = summary?.count ?? items.length

      const activityLabels = (activity) => {
        const out = []
        for (const group of Array.isArray(activity) ? activity : []) {
          const items = Array.isArray(group?.items) ? group.items : []
          if (items.length === 0) {
            if (group?.kind) out.push(String(group.kind))
            continue
          }
          for (const entry of items) out.push(String(entry?.label ?? entry?.id ?? group.kind ?? ''))
        }
        return out.filter(Boolean).slice(0, 8)
      }

      const statCard = (label, value, key) => h('div', { className: 'dkam-stat', key },
        h('strong', { title: typeof value === 'string' ? value : undefined }, value),
        h('span', null, label))

      const renderBatch = () => {
        const rangeOptions = [
          ['all', tr('rangeAll')],
          ['24h', tr('range24h')],
          ['7d', tr('range7d')],
          ['30d', tr('range30d')],
          ['90d', tr('range90d')],
        ]
        const sortOptions = [
          ['active-desc', tr('batchSortRecent')],
          ['created-desc', tr('batchSortCreated')],
          ['title', tr('batchSortTitle')],
        ]
        const stateOptions = [
          ['open', tr('batchStateOpen')],
          ['archived', tr('batchStateArchived')],
          ['all', tr('batchStateAll')],
        ]
        const failureTitle = (sessionId) => batchItems?.find(candidate => candidate.sessionId === sessionId)?.title || sessionId
        return h('div', { className: 'dkam-batch' },
          h('div', { className: 'dkam-batch-filters' },
            h('label', { className: 'dkam-search' },
              h(SearchIcon),
              h('input', {
                type: 'search',
                value: batchQuery,
                placeholder: tr('batchSearchPlaceholder'),
                'aria-label': tr('batchSearchPlaceholder'),
                onChange: event => setBatchQuery(event.target.value),
              }),
            ),
            h('label', { className: 'dkam-filter' },
              h('span', null, tr('timeRange')),
              h('select', {
                className: 'dkam-select',
                value: batchRange,
                'aria-label': tr('timeRange'),
                onChange: event => setBatchRange(event.target.value),
              }, rangeOptions.map(([value, label]) => h('option', { value, key: value }, label))),
            ),
            h('label', { className: 'dkam-filter' },
              h('span', null, tr('timeBasis')),
              h('select', {
                className: 'dkam-select',
                value: batchBasis,
                'aria-label': tr('timeBasis'),
                onChange: event => setBatchBasis(event.target.value),
              },
                h('option', { value: 'activity' }, tr('basisActivity')),
                h('option', { value: 'created' }, tr('basisCreated')),
              ),
            ),
            h('div', { className: 'dkam-filter' },
              h('span', null, tr('batchState')),
              h('div', { className: 'dkam-seg', role: 'group', 'aria-label': tr('batchState') },
                stateOptions.map(([value, label]) => h('button', {
                  type: 'button',
                  key: value,
                  'data-active': batchState === value ? 'true' : 'false',
                  'aria-pressed': batchState === value,
                  onClick: () => setBatchState(value),
                }, label)),
              ),
            ),
          ),
          h('div', { className: 'dkam-batch-bar' },
            h('label', { className: 'dkam-check' },
              h('input', {
                type: 'checkbox',
                checked: batchAllSelected,
                disabled: batchVisible.length === 0,
                onChange: toggleBatchAll,
              }),
              tr('selectAll'),
            ),
            h('span', { className: 'dkam-selected' }, `${batchSelected.size} ${tr('selectedCount')}`),
            batchMeta?.truncatedOpen || batchMeta?.truncatedArchived
              ? h('span', { className: 'dkam-hint' }, tr('batchTruncated'))
              : null,
            batchLoading ? h('span', { className: 'dkam-spinner' }) : null,
            h('select', {
              className: 'dkam-select',
              value: batchSort,
              'aria-label': tr('batchSortRecent'),
              onChange: event => setBatchSort(event.target.value),
            }, sortOptions.map(([value, label]) => h('option', { value, key: value }, label))),
          ),
          h('div', { className: 'dkam-batch-scroll' },
            batchError
              ? h('div', { className: 'dkam-empty dkam-error' },
                h(ArchiveIcon, { size: 38 }),
                h('h2', null, tr('loadFailed')),
                h('p', null, batchError),
                h('button', { className: 'dkam-btn', onClick: reloadBatch }, tr('retry')),
              )
              : batchLoading || batchItems === null
                ? h('div', { className: 'dkam-batch-list' },
                  Array.from({ length: 6 }, (_, index) => h('div', { className: 'dkam-skeleton', key: index })))
                : batchVisible.length === 0
                  ? h('div', { className: 'dkam-empty' },
                    h(ArchiveIcon, { size: 38 }),
                    h('h2', null, tr('batchEmptyTitle')),
                    h('p', null, tr('batchEmptyHint')),
                    h('div', { className: 'dkam-empty-actions' },
                      batchRange !== 'all' ? h('button', {
                        className: 'dkam-btn',
                        onClick: () => setBatchRange('all'),
                      }, tr('batchUseAllTime')) : null,
                      batchState !== 'all' ? h('button', {
                        className: 'dkam-btn',
                        onClick: () => setBatchState('all'),
                      }, tr('batchUseAllStates')) : null,
                    ),
                  )
                  : h('div', { className: 'dkam-batch-list' }, batchVisible.map(candidate => {
                    const checked = batchSelected.has(candidate.sessionId)
                    const activity = activityLabels(candidate.activity)
                    return h('div', {
                      className: 'dkam-batch-row',
                      key: candidate.sessionId,
                      'data-selected': checked ? 'true' : 'false',
                      'data-archived': candidate.archived ? 'true' : 'false',
                    },
                      h('input', {
                        type: 'checkbox',
                        checked,
                        onChange: () => toggleBatchOne(candidate.sessionId),
                        'aria-label': candidate.title || tr('unknownTitle'),
                      }),
                      h('div', {
                        className: 'dkam-batch-row-main',
                        role: 'button',
                        tabIndex: 0,
                        onClick: () => toggleBatchOne(candidate.sessionId),
                        onKeyDown: event => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault()
                            toggleBatchOne(candidate.sessionId)
                          }
                        },
                      },
                        h('div', { className: 'dkam-batch-row-title' },
                          h('span', { className: 'dkam-batch-title-text' }, candidate.title || tr('unknownTitle')),
                          candidate.archived
                            ? h('span', { className: 'dkam-pill' }, tr('candidateArchived'))
                            : candidate.active
                              ? h('span', { className: 'dkam-pill dkam-pill-warn' }, tr('candidateActive'))
                              : h('span', { className: 'dkam-pill' }, tr('candidateIdle')),
                        ),
                        h('div', { className: 'dkam-batch-row-sub' },
                          candidate.workspaceTitle || tr('unfiled'),
                          ' · ',
                          `${tr('createdAt')} ${formatTime(candidate.createdAt)}`,
                        ),
                        activity.length > 0 ? h('div', { className: 'dkam-batch-row-activity' },
                          activity.map((label, index) => h('span', {
                            className: 'dkam-activity-chip',
                            key: `${candidate.sessionId}-${index}`,
                          }, label)),
                        ) : null,
                      ),
                      h('div', { className: 'dkam-batch-side' },
                        h('div', null, formatTime(candidate.lastActivityAt ?? candidate.createdAt)),
                        h('div', { className: 'dkam-hint' }, tr('lastActive')),
                      ),
                    )
                  })),
          ),
          batchFailures.length > 0
            ? h('div', { className: 'dkam-batch-warn dkam-warn-box' },
              h('h3', null, tr('batchActiveWarn')),
              h('p', null, tr('candidateActiveHint')),
              h('ul', null,
                batchFailures.map(failure => h('li', { key: failure.sessionId },
                  failureTitle(failure.sessionId),
                  activityLabels(failure.activity).length > 0
                    ? ` — ${activityLabels(failure.activity).join(', ')}`
                    : '',
                )),
              ),
              h('label', { className: 'dkam-check', style: { marginTop: '8px' } },
                h('input', {
                  type: 'checkbox',
                  checked: batchConfirmStop,
                  onChange: event => setBatchConfirmStop(event.target.checked),
                }),
                tr('confirmStop'),
              ),
            )
            : null,
          h('div', { className: 'dkam-batch-foot' },
            h('div', { className: 'dkam-batch-summary' },
              h('strong', null, String(batchSelected.size)),
              h('span', null, tr('selectedCount')),
              h('span', { className: 'dkam-hint' },
                [
                  batchOpenSelected.length > 0 ? `${batchOpenSelected.length} ${tr('batchOpenSelected')}` : '',
                  batchArchivedSelected.length > 0 ? `${batchArchivedSelected.length} ${tr('batchArchivedSelected')}` : '',
                  batchMeta ? `${tr('batchLoaded')} ${batchMeta.total}` : '',
                ].filter(Boolean).join(' · ')),
            ),
            h('div', { className: 'dkam-batch-actions' },
              h('button', {
                className: 'dkam-btn dkam-btn-quiet',
                onClick: clearBatchSelection,
                disabled: batchSelected.size === 0,
              }, tr('batchClearSelection')),
              h('button', {
                className: 'dkam-btn',
                onClick: exportBatch,
                disabled: batchBusy || batchSelected.size === 0,
              }, tr('exportSelected')),
              h('button', {
                className: 'dkam-btn',
                onClick: restoreBatch,
                disabled: batchBusy || batchArchivedSelected.length === 0,
              }, tr('restoreSelected')),
              batchNeedsConfirm
                ? h('button', {
                  className: 'dkam-btn dkam-btn-primary',
                  onClick: () => archiveBatch(true),
                  disabled: batchBusy || !batchConfirmStop || batchOpenSelected.length === 0,
                }, tr('stopAndArchive'))
                : h('button', {
                  className: 'dkam-btn dkam-btn-primary',
                  onClick: () => archiveBatch(false),
                  disabled: batchBusy || batchOpenSelected.length === 0,
                }, tr('archiveSelected')),
            ),
          ),
        )
      }

      return h('div', { className: 'dkam-root' },
        h('header', { className: 'dkam-head' },
          h('div', { className: 'dkam-head-row' },
            h('div', { className: 'dkam-head-copy' },
              h('h1', null, tr('title')),
              h('p', null, mode === 'batch' ? tr('batchDesc') : tr('subtitle')),
            ),
            h('div', { className: 'dkam-head-actions' },
              h('div', { className: 'dkam-tabs', role: 'tablist' },
                h('button', {
                  className: 'dkam-tab',
                  role: 'tab',
                  'aria-selected': mode === 'library',
                  'data-active': mode === 'library' ? 'true' : 'false',
                  onClick: () => setMode('library'),
                }, tr('tabArchive')),
                h('button', {
                  className: 'dkam-tab',
                  role: 'tab',
                  'aria-selected': mode === 'batch',
                  'data-active': mode === 'batch' ? 'true' : 'false',
                  onClick: () => setMode('batch'),
                }, tr('tabBatch')),
              ),
              h('button', {
                className: 'dkam-btn dkam-btn-quiet',
                onClick: mode === 'batch' ? reloadBatch : reload,
                disabled: mode === 'batch' ? batchLoading : loading,
                title: tr('refresh'),
              }, h(RefreshIcon), tr('refresh')),
            ),
          ),
          mode === 'library' ? h('div', { className: 'dkam-library-head' },
            h('div', { className: 'dkam-stats' },
              statCard(tr('statArchived'), String(count), 'count'),
              statCard(tr('statSize'), knownSizes > 0 ? formatBytes(totalSize) : '—', 'size'),
              statCard(tr('statUnknownTime'), String(summary?.unknownArchivedAtCount ?? 0), 'unknown'),
              statCard(tr('statLastArchived'), latestArchived ? formatTime(latestArchived) : '—', 'latest'),
            ),
            h('div', { className: 'dkam-size-note' },
              tr('sizeNote'),
              unknownSizes > 0 ? ` · ${unknownSizes} ${tr('unknownSize')}` : '',
            ),
            h('div', { className: 'dkam-toolbar' },
              h('label', { className: 'dkam-search' },
                h(SearchIcon),
                h('input', {
                  type: 'search',
                  value: query,
                  placeholder: tr('searchPlaceholder'),
                  'aria-label': tr('searchPlaceholder'),
                  onChange: event => setQuery(event.target.value),
                }),
              ),
              h('select', {
                className: 'dkam-select',
                value: filter,
                'aria-label': tr('filterAll'),
                onChange: event => setFilter(event.target.value),
              },
                h('option', { value: 'all' }, tr('filterAll')),
                h('option', { value: 'noted' }, tr('filterNoted')),
                h('option', { value: 'tagged' }, tr('filterTagged')),
                h('option', { value: 'unknown' }, tr('filterUnknown')),
                h('option', { value: 'ghost' }, tr('filterGhost')),
              ),
              h('select', {
                className: 'dkam-select',
                value: sort,
                'aria-label': tr('sortArchivedDesc'),
                onChange: event => setSort(event.target.value),
              },
                h('option', { value: 'archived-desc' }, tr('sortArchivedDesc')),
                h('option', { value: 'archived-asc' }, tr('sortArchivedAsc')),
                h('option', { value: 'active-desc' }, tr('sortActiveDesc')),
                h('option', { value: 'size-desc' }, tr('sortSizeDesc')),
                h('option', { value: 'title' }, tr('sortTitle')),
              ),
              h('div', { className: 'dkam-toolbar-actions' },
                h('button', {
                  className: 'dkam-btn',
                  onClick: () => setMode('batch'),
                  disabled: Boolean(busy),
                }, tr('batchArchive')),
                h('label', { className: 'dkam-check' },
                  h('input', { type: 'checkbox', checked: allSelected, onChange: toggleAll }),
                  tr('selectAll'),
                ),
                selected.size > 0 ? h('span', { className: 'dkam-selected' }, `${selected.size} ${tr('selectedCount')}`) : null,
                h('button', {
                  className: 'dkam-btn',
                  onClick: restoreSelected,
                  disabled: Boolean(busy) || restorableSelected.length === 0,
                }, tr('restoreSelected')),
                h('button', {
                  className: 'dkam-btn',
                  onClick: exportSelected,
                  disabled: selected.size === 0,
                }, tr('exportSelected')),
              ),
            ),
            h('div', { className: 'dkam-viewbar' },
              h('select', {
                className: 'dkam-select',
                value: viewId,
                'aria-label': tr('views'),
                onChange: event => applyView(event.target.value),
              },
                h('option', { value: '' }, tr('allViews')),
                views.map(view => h('option', { value: view.id, key: view.id }, view.name)),
              ),
              h('button', {
                className: 'dkam-btn dkam-btn-quiet',
                onClick: () => { setViewEditorOpen(open => !open); setViewName('') },
              }, tr('saveView')),
              viewId ? h('button', {
                className: 'dkam-btn dkam-btn-quiet',
                onClick: deleteView,
                disabled: viewBusy,
              }, tr('deleteView')) : null,
            ),
            viewEditorOpen ? h('div', { className: 'dkam-view-editor' },
              h('input', {
                value: viewName,
                maxLength: 40,
                placeholder: tr('viewNamePlaceholder'),
                'aria-label': tr('viewName'),
                onChange: event => setViewName(event.target.value),
                onKeyDown: event => { if (event.key === 'Enter') saveView() },
              }),
              h('button', {
                className: 'dkam-btn dkam-btn-primary',
                onClick: saveView,
                disabled: viewBusy || viewName.trim().length === 0,
              }, tr('saveView')),
              h('button', {
                className: 'dkam-btn dkam-btn-quiet',
                onClick: () => { setViewEditorOpen(false); setViewName('') },
              }, tr('close')),
            ) : null,
            tag ? h('div', { className: 'dkam-active-filter' },
              h('span', null, `${tr('tags')}: ${tag}`),
              h('button', { type: 'button', onClick: () => setTag('') }, tr('clearTag')),
            ) : null,
          ) : null,
        ),
        mode === 'library' ? h('div', { className: 'dkam-scroll' },
          loading && items.length === 0
            ? h('div', { className: 'dkam-list' }, Array.from({ length: 6 }, (_, index) => h('div', { className: 'dkam-skeleton', key: index })))
            : loadError
              ? h('div', { className: 'dkam-empty dkam-error' },
                h(ArchiveIcon, { size: 38 }),
                h('h2', null, tr('loadFailed')),
                h('p', null, loadError),
                h('button', { className: 'dkam-btn', onClick: reload }, tr('retry')),
              )
              : items.length === 0
                ? h('div', { className: 'dkam-empty' },
                  h(ArchiveIcon, { size: 38 }),
                  h('h2', null, tr('emptyTitle')),
                  h('p', null, tr('emptyDesc')),
                  h('p', { className: 'dkam-hint' }, tr('emptyNote')),
                )
                : filtered.length === 0
                  ? h('div', { className: 'dkam-empty' },
                    h(ArchiveIcon, { size: 34 }),
                    h('h2', null, tr('noMatch')),
                    h('button', {
                      className: 'dkam-btn',
                      onClick: () => { setQuery(''); setFilter('all'); setTag(''); setSort('archived-desc') },
                    }, tr('clearFilters')),
                  )
                  : h('div', { className: 'dkam-list' }, filtered.map(row => {
                    const checked = selected.has(row.sessionId)
                    return h('div', {
                      className: 'dkam-row',
                      key: row.sessionId,
                      'data-selected': checked ? 'true' : 'false',
                    },
                      h('input', {
                        type: 'checkbox',
                        checked,
                        onChange: () => toggleOne(row.sessionId),
                        'aria-label': row.title || tr('unknownTitle'),
                      }),
                      h('div', {
                        className: 'dkam-row-body',
                        role: 'button',
                        tabIndex: 0,
                        onClick: () => openPreview(row),
                        onKeyDown: event => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault()
                            openPreview(row)
                          }
                        },
                      },
                        h('div', { className: 'dkam-row-title-line' },
                          h('span', { className: 'dkam-row-title' }, row.title || tr('unknownTitle')),
                          row.ghost ? h('span', { className: 'dkam-pill dkam-pill-warn' }, tr('ghost')) : null,
                          !row.archivedAtKnown ? h('span', { className: 'dkam-pill' }, tr('archivedAtUnknown')) : null,
                        ),
                        h('div', { className: 'dkam-row-sub' },
                          h('span', null, row.workspaceTitle || tr('unfiled')),
                          h('span', { className: 'dkam-dot' }, '·'),
                          h('span', null, `${tr('createdAt')} ${formatTime(row.createdAt)}`),
                          Number.isFinite(row.eventCount) ? h('span', { className: 'dkam-dot' }, '·') : null,
                          Number.isFinite(row.eventCount) ? h('span', null, `${row.eventCount} ${tr('events')}`) : null,
                        ),
                        row.note ? h('span', { className: 'dkam-row-note' }, row.note) : null,
                        Array.isArray(row.tags) && row.tags.length > 0
                          ? h('div', { className: 'dkam-row-tags' },
                            row.tags.map(value => h('button', {
                              type: 'button',
                              className: 'dkam-tag',
                              key: value,
                              onClick: event => {
                                event.stopPropagation()
                                setTag(value)
                              },
                            }, `#${value}`)))
                          : null,
                      ),
                      h('div', { className: 'dkam-row-meta' },
                        h('span', { title: tr('size') }, formatBytes(row.sizeBytes)),
                        h('span', { title: tr('archivedAt') }, row.archivedAtKnown ? formatTime(row.archivedAt) : tr('unknownTime')),
                      ),
                      h('div', { className: 'dkam-row-actions' },
                        h('button', {
                          className: 'dkam-btn',
                          onClick: event => { event.stopPropagation(); restoreOne(row) },
                          disabled: Boolean(busy) || row.ghost,
                        }, tr('restore')),
                        h('button', {
                          className: 'dkam-btn dkam-btn-quiet',
                          onClick: event => { event.stopPropagation(); exportSession(row.sessionId) },
                          disabled: row.ghost,
                        }, tr('export')),
                      ),
                    )
                  })),
        ) : renderBatch(),
        h('dialog', {
          ref: dialogRef,
          className: 'dkam-dialog',
          onClose: () => setPreview(null),
          'aria-labelledby': 'dkam-dialog-title',
        },
          h('div', { className: 'dkam-dialog-head' },
            h('div', null,
              h('h2', { className: 'dkam-dialog-title', id: 'dkam-dialog-title' }, previewTitle),
              h('p', { className: 'dkam-dialog-sub' },
                data?.workspaceTitle || item?.workspaceTitle || tr('unfiled'),
                ' · ',
                item?.sessionId ?? '',
              ),
            ),
            h('button', { className: 'dkam-x', onClick: closePreview, 'aria-label': tr('close') }, '×'),
          ),
          h('div', { className: 'dkam-dialog-body' },
            preview?.loading
              ? h('div', { className: 'dkam-empty' },
                h('span', { className: 'dkam-spinner' }),
                h('p', null, tr('previewLoading')),
              )
              : preview?.error
                ? h('div', { className: 'dkam-empty dkam-error' },
                  h('p', null, preview.error),
                  h('button', { className: 'dkam-btn', onClick: () => openPreview(preview.item) }, tr('retry')),
                )
                : data
                  ? h(React.Fragment, null,
                    h('div', { className: 'dkam-meta-grid' },
                      metaItem(tr('sessionId'), h('span', null,
                        h('code', null, data.sessionId),
                        h('button', { className: 'dkam-copy', onClick: () => copyId(data.sessionId) }, tr('copy')),
                      )),
                      metaItem(tr('workspace'), data.workspaceTitle || tr('unfiled')),
                      metaItem(tr('createdAt'), formatTime(data.createdAt)),
                      metaItem(tr('archivedAt'), data.archivedAtKnown ? formatTime(data.archivedAt) : tr('archivedAtUnknown')),
                      metaItem(tr('restoredAt'), data.restoredAt ? formatTime(data.restoredAt) : tr('notRestored')),
                      metaItem(tr('lastActive'), formatTime(data.lastActivityAt)),
                      metaItem(tr('size'), formatBytes(data.sizeBytes)),
                      metaItem(tr('events'), String(data.eventCount ?? '—')),
                      metaItem(`${tr('turns')} / ${tr('steps')} / ${tr('toolCalls')}`,
                        `${data.turns ?? 0} / ${data.steps ?? 0} / ${data.toolCalls ?? 0}`),
                    ),
                    data.ghost ? h('p', { className: 'dkam-hint' }, tr('ghostHint')) : null,
                    h('div', { className: 'dkam-section' },
                      h('h3', null, tr('firstUser')),
                      h('pre', { className: `dkam-excerpt${data.firstUserText ? '' : ' dkam-excerpt-empty'}` },
                        data.firstUserText || tr('noText')),
                    ),
                    h('div', { className: 'dkam-section' },
                      h('h3', null, tr('lastAssistant')),
                      h('pre', { className: `dkam-excerpt${data.lastAssistantText ? '' : ' dkam-excerpt-empty'}` },
                        data.lastAssistantText || tr('noText')),
                    ),
                    Array.isArray(data.topTools) && data.topTools.length > 0
                      ? h('div', { className: 'dkam-section' },
                        h('h3', null, tr('topTools')),
                        h('div', { className: 'dkam-tool-list' },
                          data.topTools.map(tool => h('span', { className: 'dkam-tool', key: tool.name },
                            h('b', null, tool.name), `×${tool.count}`))),
                      )
                      : null,
                    Array.isArray(data.history) && data.history.length > 0
                      ? h('div', { className: 'dkam-section' },
                        h('h3', null, tr('audit')),
                        h('ol', { className: 'dkam-timeline' },
                          data.history.map((event, index) => h('li', { key: `${event.action}-${event.at}-${index}` },
                            h('div', null,
                              h('time', null, formatTime(event.at)),
                              h('strong', null, event.action === 'archived' ? tr('auditArchived') : tr('auditRestored')),
                              h('small', null, event.source === 'user'
                                ? tr('auditSourceUser')
                                : event.source === 'system'
                                  ? tr('auditSourceSystem')
                                  : tr('auditSourcePlugin')),
                            ),
                          )),
                        ),
                      )
                      : null,
                    h('div', { className: 'dkam-section' },
                      h('h3', null, tr('transcript')),
                      transcript === null
                        ? h('button', { className: 'dkam-btn', onClick: () => loadTranscript(0) }, tr('loadTranscript'))
                        : transcript.loading
                          ? h('div', { className: 'dkam-empty' },
                            h('span', { className: 'dkam-spinner' }),
                            h('p', null, tr('transcriptLoading')),
                          )
                          : transcript.error
                            ? h('div', { className: 'dkam-empty dkam-error' },
                              h('p', null, transcript.error),
                              h('button', { className: 'dkam-btn', onClick: () => loadTranscript(0) }, tr('retry')),
                            )
                            : transcript.data
                              ? h(React.Fragment, null,
                                transcript.data.items.length === 0
                                  ? h('p', { className: 'dkam-hint' }, tr('transcriptEmpty'))
                                  : h('div', { className: 'dkam-transcript' },
                                    transcript.data.items.map(event => h('div', { className: 'dkam-event', key: event.index },
                                      h('div', { className: 'dkam-event-head' },
                                        h('span', { className: 'dkam-event-role' }, event.role ?? event.type),
                                        h('span', null, formatTime(event.time)),
                                        event.name ? h('span', null, event.name) : null,
                                      ),
                                      h('pre', { className: 'dkam-event-text' },
                                        event.text || tr('noText'),
                                        event.truncated ? ` · ${tr('truncated')}` : ''),
                                    ))),
                                h('div', { className: 'dkam-pager' },
                                  h('button', {
                                    className: 'dkam-btn',
                                    disabled: transcript.data.offset === 0,
                                    onClick: () => loadTranscript(Math.max(0, transcript.data.offset - transcript.data.limit)),
                                  }, tr('prevPage')),
                                  h('span', null, `${tr('pageInfo')} ${Math.floor(transcript.data.offset / transcript.data.limit) + 1} ${tr('of')} ${Math.max(1, Math.ceil(transcript.data.total / transcript.data.limit))}`),
                                  h('button', {
                                    className: 'dkam-btn',
                                    disabled: !transcript.data.hasMore,
                                    onClick: () => loadTranscript(transcript.data.nextOffset ?? transcript.data.offset + transcript.data.limit),
                                  }, tr('nextPage')),
                                ),
                              )
                              : null,
                    ),
                    h('div', { className: 'dkam-editor' },
                      h('label', { className: 'dkam-field' },
                        h('span', null, tr('note')),
                        h('textarea', {
                          value: noteDraft,
                          maxLength: 2000,
                          placeholder: tr('notePlaceholder'),
                          onChange: event => setNoteDraft(event.target.value),
                        }),
                      ),
                      h('label', { className: 'dkam-field' },
                        h('span', null, tr('tags')),
                        h('input', {
                          value: tagsDraft,
                          placeholder: tr('tagsPlaceholder'),
                          onChange: event => setTagsDraft(event.target.value),
                        }),
                      ),
                      h('div', { className: 'dkam-editor-actions' },
                        h('span', { className: 'dkam-hint' }, tr('sizeNote')),
                        h('button', {
                          className: 'dkam-btn',
                          onClick: saveNote,
                          disabled: saving,
                        }, saving ? tr('saving') : tr('save')),
                      ),
                    ),
                  )
                  : null,
          ),
          h('div', { className: 'dkam-dialog-foot' },
            h('button', {
              className: 'dkam-btn',
              onClick: () => item && exportSession(item.sessionId),
              disabled: !item || item.ghost,
            }, tr('downloadZip')),
            h('button', {
              className: 'dkam-btn dkam-btn-primary',
              onClick: () => item && restoreOne(item),
              disabled: !item || item.ghost || Boolean(busy),
            }, tr('restore')),
          ),
        ),
        notice ? h('div', { className: 'dkam-toast', role: 'status' }, notice) : null,
      )
    }

    /** One label/value pair in the preview grid. */
    function metaItem(label, value) {
      return h('div', { className: 'dkam-meta-item', key: label },
        h('span', { className: 'dkam-meta-label' }, label),
        h('div', { className: 'dkam-meta-value' }, value),
      )
    }

    return {
      name: NS,
      inject: ['locale', 'slots'],
      apply(ctx) {
        const effect = (register, label) => (typeof ctx.effect === 'function' ? ctx.effect(register, label) : register())
        ctx.locale.register(NS, messages)
        const translate = ctx.locale.bind(NS)
        const tr = key => {
          try {
            const text = translate(key)
            if (typeof text === 'string' && text.length > 0 && text !== key) return text
          } catch { /* fall through to the English source */ }
          return messages.en[key] ?? key
        }

        effect(installStyles, 'dk-dsh-archive-manager: styles')
        if (typeof ctx.on === 'function') {
          effect(() => ctx.on('workspace/archive-notice', async (sessionId, next) => {
            let downstream
            try {
              downstream = typeof next === 'function' ? await next() : undefined
            } catch { /* keep the local hint */ }
            let archivedAt = null
            try {
              const response = await fetch(`${BASE}/notice`, {
                method: 'POST',
                headers: {
                  'content-type': 'application/json',
                  'x-dk-archive-manager': '1',
                },
                body: JSON.stringify({ sessionId }),
              })
              const data = await response.json()
              archivedAt = Number.isFinite(data?.archivedAt) ? data.archivedAt : null
            } catch { /* the notice still works without the timestamp */ }
            const base = typeof downstream?.text === 'string' && downstream.text.length > 0
              ? downstream.text
              : tr('archiveNoticeHint')
            return {
              text: archivedAt ? `${base} · ${tr('archivedAt')} ${formatTime(archivedAt)}` : base,
              tone: downstream?.tone === 'warning' ? 'warning' : 'success',
            }
          }), 'dk-dsh-archive-manager: archive notice')
        }
        effect(() => ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: ID,
        }, () => h(ArchivePanel, { tr }))), 'dk-dsh-archive-manager: main panel')
        effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: ID,
          order: 30,
          label: () => tr('title'),
        }, ArchiveIcon)), 'dk-dsh-archive-manager: sidebar entry')
      },
    }
  },
})

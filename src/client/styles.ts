// Page styles, copied from the native Models section
// (packages/client/ui-settings-models/src/client/ModelsSection.module.css) so
// the RWKV page reads as part of Settings in both themes. Classes carry an
// `rwkv-` prefix because this bundle injects plain CSS rather than a module.

export const CSS = `
.rwkv-section{display:flex;flex-direction:column;gap:12px;max-width:720px;color:var(--dsw-alias-label-primary)}
.rwkv-title{margin:0;font-size:16px;line-height:24px;font-weight:500;color:var(--dsw-alias-label-primary)}
.rwkv-intro{margin:0;font-size:14px;line-height:22px;color:var(--dsw-alias-label-tertiary)}
.rwkv-subtitle{margin:20px 0 0;font-size:14px;line-height:22px;font-weight:500;color:var(--dsw-alias-label-primary)}
.rwkv-rows{list-style:none;margin:12px 0 0;padding:0;display:flex;flex-direction:column;gap:8px}
.rwkv-checks{display:flex;gap:20px;flex-wrap:wrap}
.rwkv-block-head{display:flex;align-items:center;justify-content:space-between}
.rwkv-plus{font-size:18px;line-height:1}
textarea.rwkv-prose{font-family:inherit;font-size:14px;line-height:22px}
.rwkv-card{border:.5px solid var(--dsw-alias-settings-card-stroke);background:var(--dsw-alias-settings-card-fill);border-radius:var(--dsw-radius-xl);padding:12px 14px;display:flex;flex-direction:column;gap:12px}
.rwkv-head{display:flex;align-items:center;gap:10px;min-height:28px}
.rwkv-identity{display:inline-flex;align-items:center;gap:6px;flex:none;max-width:60%}
.rwkv-name{font-size:14px;line-height:22px;font-weight:500;color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rwkv-tag{flex:none;padding:1px 6px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-xs);font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.rwkv-dot{display:inline-block;flex:none;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-success-primary)}
.rwkv-meta{flex:1 1 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.rwkv-actions{display:inline-flex;align-items:center;gap:4px;margin-left:auto;flex:none}
.rwkv-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:36px;padding:0 14px;border:none;border-radius:var(--dsw-radius-md);font:inherit;font-size:14px;line-height:22px;cursor:pointer}
.rwkv-btn:disabled{opacity:.4;cursor:default}
.rwkv-primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.rwkv-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.rwkv-secondary{border:.5px solid var(--dsw-alias-border-l3);background:transparent;color:var(--dsw-alias-label-primary)}
.rwkv-secondary:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-solid)}
.rwkv-small{height:28px;padding:0 10px;border-radius:var(--dsw-radius-sm);font-size:12px;line-height:18px}
.rwkv-danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary)}
.rwkv-link{box-sizing:border-box;display:inline-flex;align-items:center;height:28px;padding:0 10px;border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12px;line-height:18px;cursor:pointer}
.rwkv-link:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.rwkv-editor{border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-module-platform);padding:14px 16px;display:flex;flex-direction:column;gap:14px}
.rwkv-editor-head{display:flex;align-items:baseline;gap:8px}
.rwkv-editor-title{font-size:14px;line-height:22px;font-weight:500;color:var(--dsw-alias-label-primary)}
.rwkv-editor-sub{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.rwkv-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 14px}
.rwkv-grid3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px 14px}
.rwkv-field{display:flex;flex-direction:column;gap:6px;min-width:0}
.rwkv-wide{grid-column:1/-1}
.rwkv-label{display:inline-flex;align-items:center;gap:10px;font-size:12px;line-height:18px;font-weight:500;color:var(--dsw-alias-label-secondary)}
.rwkv-hint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.rwkv-error{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}
.rwkv-saved{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-success-primary)}
.rwkv-input{box-sizing:border-box;width:100%;height:32px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);font:inherit;font-size:14px;line-height:22px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.rwkv-input:focus{outline:none;border-color:var(--dsw-alias-state-business-primary)}
.rwkv-input::placeholder{color:var(--dsw-alias-label-dimmed)}
.rwkv-input:disabled{opacity:.6;cursor:default}
textarea.rwkv-input{height:auto;min-height:64px;padding:6px 10px;resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:18px}
.rwkv-combo{position:relative;width:100%}
.rwkv-combo-input{padding-right:30px}
.rwkv-combo-toggle{position:absolute;top:0;right:0;bottom:0;width:30px;display:inline-flex;align-items:center;justify-content:center;padding:0;border:none;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;border-radius:0 var(--dsw-radius-md) var(--dsw-radius-md) 0}
.rwkv-combo-toggle:hover{color:var(--dsw-alias-label-primary)}
.rwkv-select-trigger{display:flex;align-items:center;justify-content:space-between;gap:8px;cursor:pointer;text-align:left}
.rwkv-select-value{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rwkv-menu-chevron{flex:none;color:var(--dsw-alias-label-secondary);transition:transform 140ms ease}
.rwkv-menu-chevron-open{transform:rotate(180deg)}
.rwkv-menu{position:absolute;top:calc(100% + 4px);left:0;z-index:100;box-sizing:border-box;min-width:100%;width:max-content;max-width:min(440px,calc(100vw - 32px));max-height:240px;overflow-y:auto;padding:4px;display:flex;flex-direction:column;gap:0;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);background:var(--dsw-menu-surface-fill,var(--dsw-alias-bg-layer-1));backdrop-filter:var(--dsw-menu-backdrop-filter,none);box-shadow:var(--dsw-elevation-prominent,0 8px 24px rgba(0,0,0,.12));--dsw-elevation-stroke-color:var(--dsw-alias-border-l1)}
.rwkv-menu-end{left:auto;right:0}
.rwkv-menu-item{box-sizing:border-box;display:flex;align-items:center;gap:8px;width:100%;min-height:34px;padding:6px 8px;border:none;border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;text-align:left;cursor:pointer}
.rwkv-menu-item:hover,.rwkv-menu-item[data-active=true]{background:var(--dsw-alias-interactive-bg-hover)}
.rwkv-menu-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rwkv-menu-check{flex:none;width:14px;height:14px;color:var(--dsw-alias-label-primary)}
.rwkv-check{display:inline-flex;align-items:center;gap:8px;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);cursor:pointer}
.rwkv-check input{width:14px;height:14px;margin:0;accent-color:var(--dsw-alias-button-primary-fill)}
.rwkv-details{border-top:.5px solid var(--dsw-alias-border-l2);padding-top:10px}
.rwkv-summary{display:flex;align-items:center;gap:6px;width:fit-content;padding:2px 4px;margin-left:-4px;border-radius:var(--dsw-radius-sm);cursor:pointer;font-size:12px;line-height:18px;font-weight:500;color:var(--dsw-alias-label-secondary);list-style:none}
.rwkv-summary::-webkit-details-marker{display:none}
.rwkv-summary::before{content:'';width:5px;height:5px;border-right:1.5px solid currentcolor;border-bottom:1.5px solid currentcolor;transform:rotate(-45deg) translate(-1px,-1px);transition:transform 120ms ease}
.rwkv-details[open]>.rwkv-summary::before{transform:rotate(45deg) translate(-1px,-1px)}
.rwkv-summary:hover{color:var(--dsw-alias-label-primary)}
.rwkv-details-body{display:flex;flex-direction:column;gap:12px;padding-top:12px}
.rwkv-block{display:flex;flex-direction:column;gap:12px;padding-top:12px;border-top:.5px solid var(--dsw-alias-border-l2)}
.rwkv-block-title{font-size:12px;line-height:18px;font-weight:500;color:var(--dsw-alias-label-secondary)}
.rwkv-editor-actions{display:flex;justify-content:flex-end;align-items:center;gap:8px}
.rwkv-editor-actions .rwkv-error,.rwkv-editor-actions .rwkv-saved{margin-right:auto}
.rwkv-add{box-sizing:border-box;width:100%;display:flex;align-items:center;justify-content:center;gap:6px;height:56px;border:1px dashed var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-xl);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:14px;cursor:pointer}
.rwkv-add:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.rwkv-add:disabled{opacity:.4;cursor:default}
.rwkv-segment{display:inline-flex;flex-wrap:wrap;padding:2px;gap:2px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l4);width:fit-content}
.rwkv-segment button{height:26px;padding:0 10px;border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}
.rwkv-segment button[aria-pressed=true]{background:var(--dsw-alias-settings-card-fill);color:var(--dsw-alias-label-primary);box-shadow:0 0 0 .5px var(--dsw-alias-border-l3)}
.rwkv-list{display:flex;flex-direction:column;gap:4px}
.rwkv-option{box-sizing:border-box;display:flex;align-items:center;gap:8px;min-height:36px;padding:0 6px 0 10px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;text-align:left}
button.rwkv-option{cursor:pointer;padding-right:10px}
.rwkv-option[aria-pressed=true]{border-color:var(--dsw-alias-state-business-primary)}
.rwkv-option-main{display:flex;align-items:center;gap:8px;flex:1;min-width:0;height:34px;padding:0;border:none;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.rwkv-option-main:disabled,button.rwkv-option:disabled{cursor:default}
.rwkv-option-name{font-size:14px;line-height:22px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rwkv-option-meta{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.rwkv-option-state{margin-left:auto;flex:none;font-size:12px;line-height:18px;color:var(--dsw-alias-state-business-primary)}
.rwkv-upload{display:flex;flex-direction:column;gap:6px;padding-top:4px}
.rwkv-upload-row{display:flex;align-items:center;gap:8px}
@container (max-width:560px){.rwkv-grid,.rwkv-grid3{grid-template-columns:minmax(0,1fr)}}
.rwkv-developer-head{width:100%;padding:0;border:none;background:transparent;font:inherit;color:inherit;text-align:left;cursor:pointer}
.rwkv-chevron{flex:none;width:5px;height:5px;margin:0 2px;border-right:1.5px solid var(--dsw-alias-label-secondary);border-bottom:1.5px solid var(--dsw-alias-label-secondary);transform:rotate(-45deg) translate(-1px,-1px);transition:transform 120ms ease}
.rwkv-developer-head[aria-expanded=true] .rwkv-chevron{transform:rotate(45deg) translate(-1px,-1px)}
.rwkv-developer-body{display:flex;flex-direction:column;gap:12px;padding-top:12px;border-top:.5px solid var(--dsw-alias-border-l2)}
.rwkv-toggle{align-items:flex-start}
.rwkv-toggle input{margin-top:4px}
.rwkv-toggle-hint{display:block}
.rwkv-dir{display:flex;gap:8px;align-items:center}
.rwkv-dir .rwkv-btn{flex:none;white-space:nowrap}
.rwkv-session-meta{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.rwkv-block-head .rwkv-actions .rwkv-btn{white-space:nowrap}
.rwkv-actions{display:inline-flex;gap:6px;align-items:center}
.rwkv-stats{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-module-platform)}
.rwkv-stats-head{display:flex;flex-wrap:wrap;gap:6px 16px;align-items:baseline}
.rwkv-stat{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.rwkv-stat b{font-size:16px;margin-right:4px;color:var(--dsw-alias-label-primary)}
.rwkv-counts{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.rwkv-count{display:inline-flex;gap:4px;align-items:baseline;padding:1px 8px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);font-size:12px;line-height:18px}
.rwkv-session-toggle{cursor:pointer}
.rwkv-sessions{list-style:none;margin:0;padding:0 2px 0 0;display:flex;flex-direction:column;gap:6px;max-height:440px;overflow-y:auto}
.rwkv-session{border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg);padding:6px 10px}
.rwkv-session-head{display:flex;gap:8px;align-items:center}
.rwkv-session-title{display:flex;flex-direction:column;gap:2px;flex:1;min-width:0;border:none;background:transparent;padding:0;text-align:left;font:inherit;color:inherit;cursor:pointer}
.rwkv-session-task{font-size:13px;line-height:20px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rwkv-session-body{display:flex;flex-direction:column;gap:8px;padding:8px 0 4px}
.rwkv-session-body .rl-ledger{height:340px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md)}
/* RWKV trace ledger, after DSH's Trajectory view (ui-trajectory TrajectoryTable / Toolbar). */
.rl-root{isolation:isolate;display:flex;flex-direction:column;height:100%;min-height:0;width:100%;box-sizing:border-box;overflow:hidden;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1)}
.rl-toolbar{flex:none;display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;box-sizing:border-box;min-height:32px;padding:4px 6px;border-bottom:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1)}
.rl-toggles{display:flex;flex-wrap:wrap;align-items:center;gap:2px}
.rl-toggle{display:inline-flex;align-items:center;height:20px;padding:0 7px;gap:4px;border:0;border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-tertiary);background:transparent;cursor:pointer;font:var(--dsw-font-xxs-12)}
.rl-toggle:hover,.rl-toggle[aria-pressed=true]{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.rl-summary{margin-left:auto;padding-right:4px;font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rl-notice{flex:none;margin:0;padding:6px 12px;font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-tertiary);border-bottom:.5px solid var(--dsw-alias-border-l1)}
.rl-ledger{position:relative;flex:1;min-height:0;overflow:hidden;display:flex}
.rl-root .rl-ledger{--rl-bottom:calc(var(--dsh-composer-height,152px) + 16px)}
.rl-scroll{flex:1;min-width:0;overflow-y:auto;overflow-x:hidden;padding-bottom:var(--rl-bottom,0px)}
.rl-table{width:100%;table-layout:fixed;border-spacing:0;color:var(--dsw-alias-label-primary);font:var(--dsw-font-xxs-12)}
.rl-event-col{width:96px}
.rl-ctx-col{width:64px}
.rl-ctx-cell{text-align:right;padding-left:4px!important;padding-right:10px!important}
.rl-ctx{display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;min-width:42px;height:19px;padding:0 6px;border-radius:999px;font:600 10px/16px var(--ds-font-family-code,ui-monospace,monospace);white-space:nowrap}
.rl-ctx-green{color:var(--dsw-alias-state-success-primary,#15803d);background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#22c55e) 14%,var(--dsw-alias-bg-layer-1))}
.rl-ctx-blue{color:var(--dsw-alias-state-business-primary,#1d4ed8);background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#3b82f6) 14%,var(--dsw-alias-bg-layer-1))}
.rl-ctx-yellow{color:var(--dsw-alias-state-warn-label,#b45309);background:var(--dsw-alias-state-warn-tertiary,color-mix(in srgb,#f59e0b 18%,var(--dsw-alias-bg-layer-1)))}
.rl-ctx-red{color:var(--dsw-alias-state-error-primary,#dc2626);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#dc2626) 14%,var(--dsw-alias-bg-layer-1))}
.rl-fold-row td{height:26px;background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#3b82f6) 5%,var(--dsw-alias-bg-layer-1));border-bottom:.5px dashed var(--dsw-alias-border-l2)}
.rl-rail-fold{background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#3b82f6) 55%,var(--dsw-alias-bg-layer-1))}
.rl-tone-fold{color:var(--dsw-alias-state-business-primary,#1d4ed8);background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#3b82f6) 14%,var(--dsw-alias-bg-layer-1))}
.rl-fold-text{font-size:12px;line-height:18px}
.rl-fold-icon{flex:none;color:var(--dsw-alias-state-business-primary,#1d4ed8)}
.rl-fold-badge{font-weight:500;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.rl-fold-range{font:500 11px/16px var(--ds-font-family-code,ui-monospace,monospace);color:var(--dsw-alias-label-primary);white-space:nowrap}
.rwkv-chat-fold{display:flex;align-items:center;gap:6px;margin:4px 0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary);user-select:none}
.rwkv-chat-fold-icon{flex:none;color:var(--dsw-alias-label-tertiary)}
.rwkv-chat-fold-label{flex:none;color:var(--dsw-alias-label-tertiary)}
.rwkv-chat-fold-sep{flex:none;color:var(--dsw-alias-label-dimmed,var(--dsw-alias-label-tertiary))}
.rwkv-chat-fold-detail{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary)}
.rl-table td{box-sizing:border-box;height:30px;padding:0 8px;overflow:hidden;border-bottom:.5px solid var(--dsw-alias-border-l1);white-space:nowrap;text-overflow:ellipsis}
.rl-table tr{outline:none;transition:background-color 120ms}
.rl-table tr:not(.rl-step-row){cursor:pointer}
.rl-table tr:not(.rl-step-row):hover{background:var(--dsw-alias-interactive-bg-hover)}
.rl-table tr[data-selected=true]{background:var(--dsw-alias-interactive-bg-active)}
.rl-table tr:focus-visible{box-shadow:inset 0 0 0 1px var(--dsw-alias-state-business-primary)}
.rl-table tr[data-turn-start=true]:not(:first-child) td{border-top:1.5px solid var(--dsw-alias-border-l1)}
.rl-event{position:relative;overflow:visible!important;padding-left:36px!important;padding-right:4px!important;text-align:right}
.rl-rail{position:absolute;left:0;top:-1px;bottom:-1px;width:2px;background:color-mix(in srgb,var(--dsw-static-blue-500,#3b82f6) 22%,var(--dsw-alias-bg-layer-1))}
.rl-rail-touched{background:color-mix(in srgb,var(--dsw-alias-state-warn-label,#d9822b) 45%,var(--dsw-alias-bg-layer-1))}
.rl-rail-error{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,var(--dsw-alias-bg-layer-1))}
.rl-turn-label{position:absolute;top:0;left:0;padding:1px 5px;border-radius:0 0 2px;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-module-platform);font:8px/10px var(--ds-font-family-code,ui-monospace,monospace);white-space:nowrap}
.rl-tag{display:inline-flex;align-items:center;box-sizing:border-box;height:19px;padding:0 5px;border-radius:var(--dsw-radius-xs);font-size:10px;line-height:16px;font-weight:650;letter-spacing:.035em;white-space:nowrap}
.rl-tone-clean{color:color-mix(in srgb,var(--dsw-alias-brand-primary-new-colorprimary-new-color) 60%,var(--dsw-alias-state-error-secondary));background:color-mix(in srgb,color-mix(in srgb,var(--dsw-alias-brand-primary-new-colorprimary-new-color) 55%,var(--dsw-alias-state-error-secondary)) 15%,var(--dsw-alias-bg-layer-1))}
.rl-tone-touched{color:var(--dsw-alias-state-warn-label);background:var(--dsw-alias-state-warn-tertiary)}
.rl-tone-error{color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,var(--dsw-alias-bg-layer-1))}
.rl-tone-neutral{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-module-platform)}
.rl-content{padding-left:4px!important}
.rl-content-inner{display:flex;align-items:center;gap:6px;min-width:0}
.rl-text{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rl-dim{color:var(--dsw-alias-label-tertiary)}
.rl-call-name{color:var(--dsw-alias-label-primary);font:400 12px/18px Menlo,Consolas,'Liberation Mono','PingFang SC',monospace}
.rl-call-payload{margin-left:7px;color:var(--dsw-alias-label-secondary);font:400 12px/18px var(--ds-font-family-code,ui-monospace,monospace)}
.rl-chips{display:inline-flex;flex-wrap:wrap;gap:4px}
.rl-chip{flex:none;padding:0 5px;border-radius:var(--dsw-radius-xs);font-size:10px;line-height:16px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-module-platform);white-space:nowrap}
.rl-chip-warn{color:var(--dsw-alias-state-warn-label);background:var(--dsw-alias-state-warn-tertiary)}
.rl-cut{flex:none;padding:0 5px;border-radius:var(--dsw-radius-xs);font-size:10px;line-height:16px;color:var(--dsw-alias-brand-primary-new-colorprimary-new-color);background:color-mix(in srgb,var(--dsw-alias-brand-primary-new-colorprimary-new-color) 10%,var(--dsw-alias-bg-module-platform))}
.rl-chip-muted{color:var(--dsw-alias-label-tertiary)}
.rl-step-row td{height:22px;border-bottom:.5px dashed var(--dsw-alias-border-l1)}
.rl-step{display:flex;align-items:center;gap:6px;min-width:0;overflow:hidden;color:var(--dsw-alias-label-tertiary);font-size:11px}
.rl-step-arrow{flex:none;color:var(--dsw-alias-label-tertiary)}
.rl-change{flex:none;padding:0 4px;border-radius:var(--dsw-radius-xs);font:10px/15px var(--ds-font-family-code,ui-monospace,monospace);color:var(--dsw-alias-state-warn-label);background:var(--dsw-alias-state-warn-tertiary);cursor:default}
.rl-step-note{flex:none}
.rl-change-list{display:flex;flex-direction:column;gap:2px;font:11px/16px var(--ds-font-family-code,ui-monospace,monospace)}
.rl-step code,.rl-kv code{font:11px/16px var(--ds-font-family-code,ui-monospace,monospace);color:var(--dsw-alias-label-secondary)}
.rl-empty{margin:0;padding:16px;font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-tertiary)}
.rl-inspector{position:absolute;top:0;right:0;bottom:0;z-index:5;width:min(560px,72%);display:flex;flex-direction:column;box-sizing:border-box;padding-bottom:var(--rl-bottom,0px);border-left:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-layer-1));box-shadow:var(--dsw-elevation-panel,-8px 0 24px rgba(0,0,0,.06))}
.rl-inspector-head{flex:none;display:flex;align-items:center;gap:10px;padding:10px 12px 8px 16px}
.rl-inspector-title{flex:1;min-width:0;font:var(--dsw-font-xs-13);color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rl-icon{width:24px;height:24px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font-size:18px;line-height:1;cursor:pointer}
.rl-icon:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.rl-tabs{flex:none;display:flex;gap:16px;padding:0 16px;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.rl-tabs button{height:32px;padding:0;border:0;border-bottom:2px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xs-13);cursor:pointer}
.rl-tabs button[aria-selected=true]{color:var(--dsw-alias-state-business-primary);border-bottom-color:var(--dsw-alias-state-business-primary)}
.rl-inspector-body{flex:1;min-height:0;overflow:auto;padding:12px 16px;display:flex;flex-direction:column;gap:10px}
.rl-kv{display:grid;grid-template-columns:96px minmax(0,1fr);gap:6px 12px;font:var(--dsw-font-xs-13)}
.rl-kv-key{color:var(--dsw-alias-label-tertiary)}
.rl-kv-value{min-width:0;overflow-wrap:anywhere}
.rl-section-title{font:var(--dsw-font-xs-13);color:var(--dsw-alias-label-secondary);font-weight:500}
.rl-prose{font:var(--dsw-font-xs-13);line-height:20px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap}
.rl-pre{margin:0;padding:8px 10px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-module-platform);font:12px/18px var(--ds-font-family-code,ui-monospace,monospace);white-space:pre-wrap;word-break:break-word}
.rl-pre-full{flex:1}
/* Right-sidebar live character-level RWKV wire viewer. */
.rw-root{--rw-bg-page:#FFFFFF;--rw-text-primary:#18181B;--rw-text-muted:#71717A;--rw-user-bg:#F4F7FB;--rw-user-border:#D8E3F2;--rw-user-footer:#E8EFF9;--rw-user-accent:#2563EB;--rw-assistant-bg:#FAFAFC;--rw-assistant-border:#E4E4E9;--rw-assistant-footer:#F0F0F5;--rw-assistant-accent:#6D28D9;--rw-think-bg:#FFFBEB;--rw-think-border:#F5DFB0;--rw-think-footer:#FEF3C7;--rw-think-accent:#B45309;--rw-call-bg:#F0FAFC;--rw-call-border:#BEE7F0;--rw-call-footer:#E0F4F8;--rw-call-accent:#0E7490;--rw-resp-bg:#F2FBF6;--rw-resp-border:#C3E8D5;--rw-resp-footer:#E3F5EC;--rw-resp-accent:#047857;--rw-err-bg:#FFF5F5;--rw-err-border:#F8CACA;--rw-err-footer:#FDE8E8;--rw-err-accent:#BE123C;display:flex;flex-direction:column;height:100%;min-height:0;width:100%;box-sizing:border-box;background:var(--rw-bg-page);color:var(--rw-text-primary)}
.rw-toolbar{flex:none;display:flex;flex-wrap:wrap;align-items:center;gap:6px 8px;padding:6px 10px;border-bottom:.5px solid var(--dsw-alias-border-l2);background:var(--rw-bg-page)}
.rw-status{display:inline-flex;align-items:center;gap:6px;font-size:12px;line-height:18px;color:var(--rw-text-muted)}
.rw-ctx-pill{gap:5px;padding:0 7px}
.rw-dot{width:6px;height:6px;border-radius:50%;flex:none;background:var(--dsw-alias-label-dimmed,#9ca3af)}
.rw-dot-idle{background:currentColor}
.rw-dot-live{background:currentColor;box-shadow:0 0 0 3px color-mix(in srgb,currentColor 25%,transparent);animation:rw-pulse 1.2s ease-in-out infinite}
@keyframes rw-pulse{0%,100%{opacity:1}50%{opacity:.45}}
.rw-controls{display:inline-flex;align-items:center;gap:4px;margin-left:auto;flex-wrap:wrap}
.rw-mode-seg{display:inline-flex;align-items:center;padding:1px;gap:1px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:var(--rw-assistant-footer)}
.rw-mode-btn{height:18px;padding:0 6px;border:0;border-radius:calc(var(--dsw-radius-sm) - 1px);background:transparent;color:var(--rw-text-muted);font:var(--dsw-font-xxs-12);font-size:11px;cursor:pointer;white-space:nowrap}
.rw-mode-btn:hover{color:var(--rw-text-primary)}
.rw-mode-btn[aria-pressed=true]{background:var(--rw-bg-page);color:var(--rw-text-primary);box-shadow:0 1px 2px rgba(0,0,0,.06)}
.rw-legend{flex:none;display:flex;flex-wrap:wrap;align-items:center;gap:4px 12px;padding:5px 12px;border-bottom:.5px solid var(--dsw-alias-border-l1);background:var(--rw-bg-page)}
.rw-swatch{display:inline-flex;align-items:center;gap:5px;font:500 11px/16px var(--ds-font-family-code,ui-monospace,monospace);color:var(--rw-text-muted)}
.rw-swatch::before{content:'';width:6px;height:6px;border-radius:50%;flex:none;background:var(--rw-dot-color,var(--rw-text-muted))}
.rw-swatch-user{--rw-dot-color:var(--rw-user-accent)}
.rw-swatch-assistant{--rw-dot-color:var(--rw-assistant-accent)}
.rw-swatch-think{--rw-dot-color:var(--rw-think-accent)}
.rw-swatch-call{--rw-dot-color:var(--rw-call-accent)}
.rw-swatch-result{--rw-dot-color:var(--rw-resp-accent)}
.rw-swatch-error{--rw-dot-color:var(--rw-err-accent)}
.rw-swatch-folded{--rw-dot-color:var(--rw-text-muted)}
.rw-empty{flex:1;display:flex;align-items:center;justify-content:center;padding:16px;background:var(--rw-bg-page)}
.rw-scroll{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;scrollbar-gutter:stable;padding:10px 12px 24px;background:var(--rw-bg-page)}
.rw-blocks{display:flex;flex-direction:column;gap:10px;font:12px/1.6 var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);color:var(--rw-text-primary)}
.rw-card{position:relative;box-sizing:border-box;width:100%;overflow:clip;border-radius:var(--dsw-radius-md);border:1px solid var(--rw-assistant-border);background:var(--rw-assistant-bg);transition:border-color 120ms ease}
.rw-card-content{padding:9px 11px}
.rw-card-system{--rw-card-footer:var(--rw-assistant-footer);--rw-card-border:var(--rw-assistant-border);--rw-card-accent:var(--rw-text-muted);background:var(--rw-assistant-bg);border-color:var(--rw-assistant-border)}
.rw-system-collapsed{display:flex;align-items:center;gap:6px;padding:9px 11px;color:var(--rw-text-muted)}
.rw-system-preview{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1}
.rw-card-user{--rw-card-footer:var(--rw-user-footer);--rw-card-border:var(--rw-user-border);--rw-card-accent:var(--rw-user-accent);background:var(--rw-user-bg);border-color:var(--rw-user-border)}
.rw-card-assistant{--rw-card-footer:var(--rw-assistant-footer);--rw-card-border:var(--rw-assistant-border);--rw-card-accent:var(--rw-assistant-accent);background:var(--rw-assistant-bg);border-color:var(--rw-assistant-border)}
.rw-card-tool{--rw-card-footer:var(--rw-resp-footer);--rw-card-border:var(--rw-resp-border);--rw-card-accent:var(--rw-resp-accent);background:var(--rw-resp-bg);border-color:var(--rw-resp-border)}
.rw-card-error{--rw-card-footer:var(--rw-err-footer);--rw-card-border:var(--rw-err-border);--rw-card-accent:var(--rw-err-accent);background:var(--rw-err-bg);border-color:var(--rw-err-border)}
.rw-card-folded{--rw-card-footer:var(--rw-assistant-footer);--rw-card-border:var(--rw-assistant-border);--rw-card-accent:var(--rw-text-muted);background:var(--rw-assistant-bg);border:1px dashed var(--rw-assistant-border)}
.rw-card-other{--rw-card-footer:var(--rw-assistant-footer);--rw-card-border:var(--rw-assistant-border);--rw-card-accent:var(--rw-text-muted);background:var(--rw-assistant-bg)}
.rw-card-body{white-space:pre-wrap;word-break:break-word}
.rw-card-tok{flex:none;display:inline-flex;align-items:center;gap:3px;padding:2px 6px;border:none;border-radius:var(--dsw-radius-xs);background:var(--rw-card-footer,var(--rw-assistant-footer));color:var(--rw-card-accent,var(--rw-text-muted));font:500 10px/14px var(--ds-font-family-code,ui-monospace,monospace);white-space:nowrap;user-select:none}
.rw-card-tok-btn{cursor:pointer;background:color-mix(in srgb,var(--rw-card-footer,var(--rw-assistant-footer)) 78%,transparent);border:.5px solid color-mix(in srgb,var(--rw-card-border,var(--rw-assistant-border)) 85%,transparent);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);transition:background-color 120ms ease,border-color 120ms ease}
.rw-card-tok-btn:hover{background:var(--rw-card-footer,var(--rw-assistant-footer));border-color:color-mix(in srgb,var(--rw-card-accent,var(--rw-text-muted)) 40%,var(--rw-card-border,var(--rw-assistant-border)))}
.rw-card-tok-float{float:right;margin:0 0 4px 10px}
.rw-card-tok-sticky{position:sticky;top:8px;z-index:2;float:right;margin:0 0 4px 10px;box-shadow:0 1px 4px rgba(0,0,0,.06)}
.rw-tok-chevron{flex:none;transition:transform 140ms ease}
.rw-tok-chevron-open{transform:rotate(180deg)}
.rw-card-hardcut{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:5;overflow:hidden;color:var(--rw-text-muted)}
.rw-span-plain{color:var(--rw-text-primary)}
.rw-span-label{font-weight:700;color:var(--rw-card-accent,var(--rw-text-primary));margin-right:4px}
.rw-span-think{background:var(--rw-think-bg);padding:1px 4px;margin-right:4px;border-radius:4px;box-shadow:inset 0 0 0 .5px var(--rw-think-border);box-decoration-break:clone;-webkit-box-decoration-break:clone}
.rw-span-think-past{background:var(--rw-think-bg);color:var(--rw-text-muted);opacity:.72;padding:1px 4px;margin-right:4px;border-radius:4px;box-decoration-break:clone;-webkit-box-decoration-break:clone}
.rw-span-think-empty{background:var(--rw-assistant-footer);color:var(--rw-text-muted);padding:1px 4px;margin-right:4px;border-radius:4px}
.rw-span-tool-call{background:var(--rw-call-bg);border-radius:3px;box-shadow:inset 0 0 0 .5px var(--rw-call-border);box-decoration-break:clone;-webkit-box-decoration-break:clone}
.rw-span-tool-result{background:transparent}
.rw-span-tool-error{background:transparent;color:var(--rw-err-accent)}
.rw-span-folded{color:var(--rw-text-muted)}
.rw-cursor{display:inline-block;margin-left:1px;color:var(--rw-user-accent);animation:rw-blink .9s step-end infinite}
@keyframes rw-blink{0%,100%{opacity:1}50%{opacity:0}}
`

/** Mounts the stylesheet once; returns its removal for plugin unload. */
export function mountStyles(): () => void {
  if (typeof document === 'undefined') return () => {}
  const id = 'dsh-rwkv-plugin-styles'
  document.getElementById(id)?.remove()
  const tag = document.createElement('style')
  tag.id = id
  tag.dataset.plugin = 'dsh-rwkv-plugin'
  tag.textContent = CSS
  document.head.appendChild(tag)
  return () => tag.remove()
}

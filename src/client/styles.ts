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
.rwkv-select{appearance:none;cursor:pointer;padding-right:32px;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%2381858C' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 12px center;background-size:12px 12px}
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
.rwkv-segment{display:inline-flex;padding:2px;gap:2px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l4);width:fit-content}
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
.rwkv-developer>summary{list-style:none;cursor:pointer}
.rwkv-developer>summary::-webkit-details-marker{display:none}
.rwkv-developer-body{display:flex;flex-direction:column;gap:12px;padding-top:4px}
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
.rwkv-sessions,.rwkv-frames{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.rwkv-session{border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg);padding:6px 10px}
.rwkv-session-head{display:flex;gap:8px;align-items:center}
.rwkv-session-title{display:flex;flex-direction:column;gap:2px;flex:1;min-width:0;border:none;background:transparent;padding:0;text-align:left;font:inherit;color:inherit;cursor:pointer}
.rwkv-session-task{font-size:13px;line-height:20px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rwkv-session-body{display:flex;flex-direction:column;gap:8px;padding:8px 0 4px}
.rwkv-frame{border-left:3px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1)}
.rwkv-frame-touched{border-left-color:var(--dsw-alias-state-warning-primary,#d9822b)}
.rwkv-frame-raw{border-left-color:var(--dsw-alias-state-error-primary)}
.rwkv-frame-clean{border-left-color:var(--dsw-alias-state-success-primary)}
.rwkv-frame-head{display:flex;flex-wrap:wrap;gap:6px;align-items:center;width:100%;padding:5px 8px;border:none;background:transparent;font:inherit;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);text-align:left;cursor:pointer}
.rwkv-frame-no{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.rwkv-frame-stage{color:var(--dsw-alias-label-secondary)}
.rwkv-frame-meta{margin-left:auto;color:var(--dsw-alias-label-tertiary)}
.rwkv-badge{padding:0 6px;border-radius:var(--dsw-radius-xs);font-weight:500}
.rwkv-badge-clean{color:var(--dsw-alias-state-success-primary)}
.rwkv-badge-touched{color:var(--dsw-alias-state-warning-primary,#d9822b)}
.rwkv-badge-raw{color:var(--dsw-alias-state-error-primary)}
.rwkv-badge-old{color:var(--dsw-alias-label-tertiary)}
.rwkv-chip{padding:0 6px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-xs);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}
.rwkv-frame-body{display:flex;flex-direction:column;gap:6px;padding:0 8px 8px}
.rwkv-frame-label{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.rwkv-pre{margin:0;max-height:360px;overflow:auto;padding:8px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-module-platform);font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:12px;line-height:18px;white-space:pre-wrap;word-break:break-word}
.rwkv-pre-prompt{max-height:480px}
.rwkv-step{display:flex;flex-wrap:wrap;gap:4px 6px;align-items:center;padding:2px 8px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.rwkv-view{box-sizing:border-box;height:100%;overflow:auto;padding:12px 16px;display:flex;flex-direction:column;gap:10px;color:var(--dsw-alias-label-primary)}
.rwkv-view-bar{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center}
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

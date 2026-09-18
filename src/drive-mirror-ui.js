// Keeps the Drive control explicit: it mirrors the real folder and never creates an archive.
const driveMirrorUi = new MutationObserver(() => {
  document.querySelectorAll('.drive-format').forEach((select) => { select.hidden = true; });
  document.querySelectorAll('.drive-switch span').forEach((label) => { label.textContent = 'Backup espelhado no Drive'; });
  document.querySelectorAll('.drive-now').forEach((button) => { button.textContent = 'Sincronizar agora'; button.title = 'Atualizar somente os arquivos alterados no espelho do Google Drive'; });
});
driveMirrorUi.observe(document.body, { childList: true, subtree: true });

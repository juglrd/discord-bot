console.log('[bootstrap] starting bot');
try {
  await import('./index.js');
} catch (e) {
  console.error('[bootstrap] FATAL STARTUP ERROR');
  console.error('[bootstrap] name:', e?.name);
  console.error('[bootstrap] code:', e?.code);
  console.error('[bootstrap] message:', e?.message);
  console.error('[bootstrap] stack:', e?.stack);
  process.exitCode = 1;
}

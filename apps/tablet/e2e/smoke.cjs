// Prueba de humo de la app de tablet sobre el build (npm run build:tablet && npm run preview -w apps/tablet).
// Recorre: crear evaluación, alcance, responder, No aplica, evidencia, resultados, plan, cola de
// sincronización, persistencia cifrada y ancho angosto. Uso: node apps/tablet/e2e/smoke.cjs
// Variables opcionales: APP_URL, CHROMIUM_PATH, PLAYWRIGHT_MODULE.
// Con SYNC_URL (build hecho con VITE_SYNC_URL y VITE_SYNC_TOKEN=dev:evaluador) también sincroniza
// contra el servidor real y verifica lo que quedó allá.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACgAAAAeCAIAAADRv8uKAAAAKklEQVR4nO3NMQ0AAAgDsOmacuQhA44m/ZtpT0QsFovFYrFYLBaLxX/jBbz4foxh4KpyAAAAAElFTkSuQmCC', 'base64');
(async () => {
  const b = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const page = await b.newPage({ viewport: { width: 1340, height: 800 } });
  const errs = [];
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('response', (r) => { if (r.status() >= 400) errs.push(r.status() + ' ' + r.url()); });
  page.on('pageerror', (e) => errs.push(String(e)));
  const ok = (c, m) => { console.log((c ? 'OK  ' : 'FAIL') + ' ' + m); if (!c) process.exitCode = 1; };
  await page.goto(process.env.APP_URL || 'http://localhost:4173/');
  await page.getByText('Mis evaluaciones').waitFor();
  await page.getByRole('button', { name: 'Nueva evaluación' }).click();
  await page.getByText('Antecedentes', { exact: true }).first().waitFor();
  await page.fill('#f-company', 'Minera Prueba'); await page.fill('#f-site', 'Faena Norte'); await page.locator('#f-int').click();
  await page.waitForTimeout(200);
  ok(await page.locator('.top h1 small').innerText().then((t) => t.includes('Minera Prueba')), 'antecedentes guardados');
  const groups = page.locator('[role=group][aria-label^="¿Aplica"]');
  const n = await groups.count();
  for (let i = 0; i < n; i++) await groups.nth(i).getByRole('button', { name: 'Aplica', exact: true }).click();
  // última dimensión: no aplica con justificación
  await groups.nth(n - 1).getByRole('button', { name: 'No aplica' }).click();
  await page.fill('#dim-just', 'Sin turnos nocturnos en esta faena');
  await page.locator('.dialog, [role=dialog]').getByRole('button', { name: 'Marcar No aplica' }).click();
  ok(await page.getByText('No aplica: Sin turnos nocturnos').count() === 1, `alcance definido (${n} dimensiones, 1 no aplica)`);
  await page.locator('.nav', { hasText: 'Preguntas' }).click();
  await page.locator('.opt').nth(4).click();
  await page.waitForTimeout(300);
  ok(await page.locator('.opt[aria-pressed=true] .sc').innerText() === '100%', 'respuesta 100 % marcada');
  await page.fill('#note', 'Revisé el procedimiento vigente'); await page.locator('.qtext').click();
  await page.setInputFiles('#photo', { name: 'evidencia.png', mimeType: 'image/png', buffer: PNG });
  await page.locator('.thumbs img').waitFor({ timeout: 5000 });
  ok(true, 'foto de evidencia guardada y mostrada');
  await page.getByRole('button', { name: 'Siguiente pendiente' }).click();
  await page.locator('.opt').nth(1).click();
  await page.getByRole('button', { name: 'Siguiente pendiente' }).click();
  await page.getByRole('button', { name: 'Marcar No aplica' }).click();
  await page.fill('#na-just', 'No hay contratistas');
  await page.locator('[role=dialog], .dialog').getByRole('button', { name: 'Marcar No aplica' }).click();
  ok(await page.getByText('Marcada como No aplica.').count() === 1, 'pregunta No aplica con justificación');
  ok(await page.evaluate(() => document.documentElement.scrollWidth) <= 1340, 'ancho tablet sin desborde');
  await page.locator('.nav', { hasText: 'Resultados' }).click();
  const big = await page.locator('.gauge .big').innerText();
  ok(/\d/.test(big), `resultado global preliminar: ${big}`);
  ok(await page.getByRole('button', { name: 'Cerrar evaluación' }).isDisabled(), 'cierre bloqueado con preguntas pendientes');
  await page.locator('.nav', { hasText: 'Plan de acción' }).click();
  const gapRows = await page.locator('.dimtable tbody tr').count();
  await page.locator('select[aria-label=Impacto]').first().selectOption('5');
  await page.locator('select[aria-label=Esfuerzo]').first().selectOption('2');
  ok(await page.locator('.dimtable tbody .prio.p1').count() === 1, `brecha priorizada P1 (${gapRows} brechas)`);
  await page.locator('.nav', { hasText: 'Sincronizar' }).click();
  const ops = await page.locator('.op').count();
  ok(ops > 0, `${ops} cambios en cola; nada se envía sin confirmar`);
  if (process.env.SYNC_URL) {
    await page.getByRole('button', { name: 'Confirmar y sincronizar' }).click();
    await page.getByText('Todo está sincronizado.').waitFor({ timeout: 15000 });
    ok(await page.getByText(/cambios aceptados, 1 archivos subidos\./).count() === 1, 'sincronización confirmada: cambios aceptados y foto subida');
    const h = { authorization: 'Bearer dev:evaluador' };
    const list = await (await fetch(`${process.env.SYNC_URL}/v1/evaluations`, { headers: h })).json();
    const ev = list.find((e) => e.company === 'Minera Prueba');
    const det = await (await fetch(`${process.env.SYNC_URL}/v1/evaluations/${ev.id}`, { headers: h })).json();
    ok(det.answers.length === 3 && det.evidence.length === 1 && det.actions[0].impact === 5 && det.scopes.length === 12,
      `el servidor tiene la evaluación (${det.answers.length} respuestas, ${det.evidence.length} foto, ${det.scopes.length} dimensiones, plan P1)`);
    const img = await fetch(`${process.env.SYNC_URL}/v1/files/${det.evidence[0].sha256}`, { headers: h });
    ok(img.ok && Buffer.from(await img.arrayBuffer()).equals(PNG), 'la foto en el servidor es idéntica a la original');
  } else {
    ok(await page.getByRole('button', { name: 'Confirmar y sincronizar' }).isDisabled(), 'sin servidor configurado, el botón queda desactivado');
  }
  // persistencia cifrada: recargar
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForTimeout(800);
  await page.reload();
  await page.getByText('Minera Prueba').first().waitFor({ timeout: 5000 });
  ok(true, 'la evaluación sigue ahí después de recargar');
  const enc = await page.evaluate(() => new Promise((res) => {
    const r = indexedDB.open('fs-tablet');
    r.onsuccess = () => {
      const st = r.result.transaction('kv').objectStore('kv');
      const keys = st.getAllKeys();
      keys.onsuccess = () => {
        const g = st.get('fs-db-v1');
        g.onsuccess = () => {
          const ct = new Uint8Array(g.result.ct);
          const head = new TextDecoder().decode(ct.slice(0, 15));
          const txt = new TextDecoder('latin1').decode(ct);
          res({ keys: keys.result.map(String), sqliteHeader: head === 'SQLite format 3', leaks: txt.includes('Minera Prueba') });
        };
      };
    };
  }));
  ok(!enc.sqliteHeader && !enc.leaks, 'base guardada cifrada (sin cabecera SQLite ni texto legible)');
  ok(enc.keys.some((k) => k.startsWith('evidence/')), 'foto guardada aparte, cifrada');
  // teléfono / tablet vertical: sin scroll horizontal
  await page.setViewportSize({ width: 400, height: 800 });
  await page.getByText('Minera Prueba').first().click().catch(() => {});
  await page.waitForTimeout(300);
  const sw = await page.evaluate(() => document.documentElement.scrollWidth);
  ok(sw <= 400, `ancho angosto sin desborde (scrollWidth ${sw})`);
  ok(errs.length === 0, 'sin errores de consola' + (errs.length ? ': ' + errs.join(' | ') : ''));
  await b.close();
})();

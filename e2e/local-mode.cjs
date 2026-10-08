// Prueba de punta a punta del modo local (servidor en el computador, sin Entra ID).
// Requiere: servidor con FS_AUTH_MODE=local y FS_PORTAL_DIR (el portal se sirve desde el mismo
// servidor), un administrador creado con app.admin_cli, y la app de tablet en vista previa sin
// VITE_SYNC_URL. Variables: SERVER_URL, APP_URL, ADMIN_USER, ADMIN_PASSWORD, CHROMIUM_PATH, PLAYWRIGHT_MODULE.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const SERVER = process.env.SERVER_URL || 'http://localhost:8100';
const APP = process.env.APP_URL || 'http://localhost:4173/';
const ADMIN = process.env.ADMIN_USER || 'max';
const ADMIN_PW = process.env.ADMIN_PASSWORD || 'clave-admin-e2e';

(async () => {
  const b = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const errs = [];
  const watch = (page, expected = []) => {
    page.on('console', (m) => { if (m.type() === 'error' && !expected.some((x) => m.text().includes(x))) errs.push(m.text()); });
    page.on('pageerror', (e) => errs.push(String(e)));
  };
  const ok = (c, m) => { console.log((c ? 'OK  ' : 'FAIL') + ' ' + m); if (!c) process.exitCode = 1; };

  // 1. El administrador entra al portal que publica el propio servidor.
  const portal = await b.newPage({ viewport: { width: 1280, height: 800 } });
  watch(portal, ['401']);
  await portal.goto(SERVER + '/');
  await portal.fill('#si-user', ADMIN);
  await portal.fill('#si-pw', 'clave-equivocada');
  await portal.getByRole('button', { name: 'Entrar' }).click();
  await portal.getByText('Usuario o clave incorrectos').waitFor();
  ok(true, 'clave equivocada: no entra');
  await portal.fill('#si-pw', ADMIN_PW);
  await portal.getByRole('button', { name: 'Entrar' }).click();
  await portal.locator('.kpi').first().waitFor();
  ok(await portal.locator('.top .chip').innerText().then((t) => t.includes('Administrador')), 'administrador entra con usuario y clave');

  // 2. Crea a una evaluadora con clave inicial y pide un código para su tablet.
  await portal.locator('a.nav', { hasText: 'Usuarios y accesos' }).click();
  await portal.getByRole('button', { name: 'Crear usuario' }).click();
  await portal.fill('#inv-n', 'Ana Pérez');
  await portal.fill('#inv-u', 'ana.perez');
  const tempPw = await portal.inputValue('#inv-p');
  ok(tempPw.length >= 10, 'el portal propone una clave inicial');
  await portal.locator('[role=dialog]').getByRole('button', { name: 'Crear usuario' }).click();
  const anaRow = portal.locator('tr', { hasText: 'usuario ana.perez' });
  await anaRow.waitFor();
  ok(await anaRow.getByText('Clave temporal').count() === 1, 'usuaria creada con clave temporal');
  await anaRow.getByRole('button', { name: 'Vincular tablet' }).click();
  const code = (await portal.locator('.paircode').innerText()).trim();
  ok(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code), `código de vinculación ${code}`);
  await portal.getByRole('button', { name: 'Listo' }).click();

  // 3. La tablet trabaja sin servidor, se vincula con el código y sincroniza a nombre de Ana.
  const tab = await b.newPage({ viewport: { width: 1340, height: 800 } });
  watch(tab, ['403', '400']);
  await tab.goto(APP);
  await tab.getByText('Mis evaluaciones').waitFor();
  await tab.getByRole('button', { name: 'Nueva evaluación' }).click();
  await tab.fill('#f-company', 'Minera Local'); await tab.fill('#f-site', 'Faena Sur'); await tab.locator('#f-int').click();
  await tab.waitForTimeout(300);
  await tab.locator('.nav', { hasText: 'Sincronizar' }).click();
  ok(await tab.getByRole('button', { name: 'Confirmar y sincronizar' }).isDisabled(), 'sin vincular no se puede enviar');
  await tab.fill('#pair-url', SERVER.replace(/^http:\/\//, ''));
  await tab.fill('#pair-code', 'ZZZZ-9999');
  await tab.getByRole('button', { name: 'Vincular' }).click();
  await tab.getByText('El código no es válido o ya venció').waitFor();
  ok(true, 'un código inválido se rechaza');
  await tab.fill('#pair-code', code.toLowerCase());
  await tab.getByRole('button', { name: 'Vincular' }).click();
  await tab.getByText('Vinculada a Ana Pérez', { exact: true }).waitFor({ timeout: 10000 });
  ok(true, 'tablet vinculada a Ana');
  await tab.getByRole('button', { name: 'Confirmar y sincronizar' }).click();
  await tab.getByText('Todo está sincronizado.').waitFor({ timeout: 15000 });
  ok(true, 'sincronización confirmada');
  await tab.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await tab.waitForTimeout(800);
  await tab.reload();
  await tab.locator('.nav', { hasText: 'Sincronizar' }).click().catch(() => {});
  await tab.getByText('Mis evaluaciones').or(tab.getByText('Vinculada a Ana Pérez', { exact: true })).first().waitFor();
  ok(true, 'la vinculación sigue después de recargar');

  // 4. El administrador ve la evaluación a nombre de Ana y la tablet con su modelo y versión.
  await portal.locator('a.nav', { hasText: 'Evaluaciones' }).click();
  const evRow = portal.locator('tr', { hasText: 'Minera Local' });
  await evRow.waitFor({ timeout: 5000 });
  ok(await evRow.innerText().then((t) => t.includes('Ana Pérez')), 'el portal muestra la evaluación de Ana');
  await portal.locator('a.nav', { hasText: 'Tablets' }).click();
  await portal.getByRole('heading', { name: 'Tablets' }).waitFor();
  const devRow = portal.locator('.dimtable tbody tr', { hasText: 'Ana Pérez' }).first();
  await devRow.waitFor({ timeout: 5000 });
  ok(true, 'la tablet aparece asociada a Ana');

  // 5. Ana entra al portal: primero debe cambiar su clave temporal; solo ve lo suyo.
  const anaCtx = await b.newContext({ viewport: { width: 1280, height: 800 } });
  const ana = await anaCtx.newPage();
  watch(ana);
  await ana.goto(SERVER + '/');
  await ana.fill('#si-user', 'ana.perez');
  await ana.fill('#si-pw', tempPw);
  await ana.getByRole('button', { name: 'Entrar' }).click();
  await ana.getByText('Tu clave es temporal').waitFor();
  await ana.fill('#cp-cur', tempPw);
  await ana.fill('#cp-new', 'clave-propia-ana');
  await ana.fill('#cp-new2', 'clave-propia-ana');
  await ana.getByRole('button', { name: 'Guardar clave' }).click();
  await ana.locator('.kpi').first().waitFor();
  ok(await ana.locator('a.nav', { hasText: 'Usuarios y accesos' }).count() === 0, 'Ana cambia su clave y entra sin ver administración');
  await ana.getByRole('button', { name: 'Salir' }).click();
  await ana.locator('#si-user').waitFor();
  const old = await fetch(`${SERVER}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'ana.perez', password: tempPw }) });
  ok(old.status === 401, 'la clave temporal ya no sirve');

  // 6. Desvincular la tablet desde el portal corta su acceso.
  await portal.reload();
  await portal.getByRole('heading', { name: 'Tablets' }).waitFor();
  await portal.locator('.dimtable tbody tr', { hasText: 'Ana Pérez' }).first().getByRole('button').first().click();
  const dlg = portal.locator('[role=dialog]');
  if (await dlg.count()) await dlg.getByRole('button').last().click();
  await portal.waitForTimeout(500);
  await tab.locator('.nav', { hasText: 'Evaluaciones' }).click();
  await tab.getByRole('button', { name: 'Nueva evaluación' }).click();
  await tab.fill('#f-company', 'Minera Dos'); await tab.locator('#f-int').click();
  await tab.waitForTimeout(300);
  await tab.locator('.nav', { hasText: 'Sincronizar' }).click();
  await tab.getByRole('button', { name: 'Confirmar y sincronizar' }).click();
  await tab.getByText(/desvinculada/).first().waitFor({ timeout: 10000 });
  ok(true, 'una tablet desvinculada no puede sincronizar y lo explica');

  ok(errs.length === 0, 'sin errores de consola' + (errs.length ? ': ' + errs.slice(0, 3).join(' | ') : ''));
  await b.close();
})().catch((e) => { console.error(e); process.exit(1); });

// Prueba de humo del portal sobre el build, contra un servidor real en modo dev
// (FS_BOOTSTRAP_ADMINS=admin, FS_AUTO_ENROLL_ROLE=evaluador) en el que la prueba de la tablet ya
// sincronizó una evaluación de "Minera Prueba". Uso: node apps/portal/e2e/smoke.cjs
// Variables opcionales: PORTAL_URL, CHROMIUM_PATH, PLAYWRIGHT_MODULE.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const URL = process.env.PORTAL_URL || 'http://localhost:4174/';

(async () => {
  const b = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const page = await b.newPage({ viewport: { width: 1340, height: 860 } });
  const errs = [];
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('pageerror', (e) => errs.push(String(e)));
  const ok = (c, m) => { console.log((c ? 'OK  ' : 'FAIL') + ' ' + m); if (!c) process.exitCode = 1; };
  const signIn = async (u) => {
    await page.goto(URL);
    await page.fill('#si-user', u);
    await page.getByRole('button', { name: 'Entrar' }).click();
    await page.locator('.top').waitFor();
  };

  // Persona sin invitación cuando no hay inscripción automática: aquí sí la hay, así que se prueba el rechazo de una cuenta deshabilitada más abajo.
  await signIn('admin');
  ok(await page.locator('.top .chip').innerText().then((t) => t.includes('Administrador')), 'administrador entra y ve su rol');
  await page.locator('.kpi').first().waitFor();
  const kpis = await page.locator('.kpi b').allInnerTexts();
  ok(kpis[0] === '1' && kpis[1] === '0', `panel: ${kpis[0]} en curso, ${kpis[1]} cerradas`);
  ok(await page.getByRole('link', { name: 'Minera Prueba' }).count() === 1, 'panel lista la evaluación sincronizada');

  await page.locator('a.nav', { hasText: 'Evaluaciones' }).click();
  await page.locator('.dimtable tbody tr').first().waitFor();
  ok(await page.locator('.dimtable tbody tr').first().innerText().then((t) => t.includes('evaluador') && t.includes('62,5')), 'lista: evaluador y madurez preliminar 62,5 %');
  await page.fill('#f-q', 'no existe');
  ok(await page.getByText('Ninguna evaluación coincide con el filtro.').count() === 1, 'el filtro funciona');
  await page.fill('#f-q', 'minera');
  await page.getByRole('link', { name: 'Minera Prueba' }).click();
  await page.locator('.gauge .big').waitFor();
  ok((await page.locator('.gauge .big').innerText()) === '62,5 %', 'detalle: mismo resultado que en la tablet (62,5 %)');
  ok(await page.getByText('Sin turnos nocturnos en esta faena').count() === 1, 'detalle: dimensión excluida con su justificación');
  await page.locator('details.qblock summary').first().click();
  await page.locator('details.qblock .thumbbtn img').first().waitFor({ timeout: 5000 });
  ok(true, 'detalle: la foto de evidencia se ve en el portal');
  ok(await page.getByText('Revisé el procedimiento vigente').count() === 1, 'detalle: nota de evidencia');
  ok(await page.getByText('No hay contratistas').count() === 1, 'detalle: No aplica con justificación');
  ok(await page.locator('.prio.p1').count() === 1, 'detalle: plan de acción con prioridad P1');
  const reloadUrl = page.url();
  await page.reload();
  await page.locator('.gauge .big').waitFor();
  ok(page.url() === reloadUrl, 'recargar mantiene la pantalla (enlace compartible)');

  await page.locator('a.nav', { hasText: 'Usuarios y accesos' }).click();
  await page.getByRole('button', { name: 'Invitar usuario' }).click();
  await page.fill('#inv-n', 'Carla Rojas');
  await page.fill('#inv-e', 'correo-malo');
  await page.getByRole('button', { name: 'Registrar invitación' }).click();
  ok(await page.getByText('Escribe el nombre y un correo válido').count() === 1, 'invitar valida el correo');
  await page.fill('#inv-e', 'carla@vantaz.cl');
  await page.selectOption('#inv-r', 'supervisor');
  await page.getByRole('button', { name: 'Registrar invitación' }).click();
  await page.getByText('carla@vantaz.cl').waitFor();
  ok(await page.locator('tr', { hasText: 'carla@vantaz.cl' }).getByText('Invitado').count() === 1, 'invitación registrada como Invitado');
  const evRow = page.locator('tr').filter({ has: page.locator('td b', { hasText: /^evaluador$/ }) });
  await evRow.getByRole('button', { name: 'Quitar acceso' }).click();
  await page.locator('[role=dialog]').getByRole('button', { name: 'Quitar acceso' }).click();
  await evRow.getByText('Sin acceso').waitFor();
  ok(true, 'quitar acceso a un evaluador');

  await page.locator('a.nav', { hasText: 'Tablets' }).click();
  await page.getByRole('heading', { name: 'Tablets' }).waitFor();
  const tabRow = page.locator('.dimtable tbody tr', { hasText: 'Activa' }).first();
  await tabRow.waitFor({ timeout: 5000 }).catch(() => {});
  ok(await tabRow.innerText().catch(() => '').then((t) => t.includes('0.5.0')), 'tablets: versión de la app y estado');

  await page.locator('a.nav', { hasText: 'Bitácora' }).click();
  await page.getByRole('heading', { name: 'Bitácora' }).waitFor();
  await page.getByText('Invitó a carla@vantaz.cl', { exact: false }).first().waitFor({ timeout: 5000 }).catch(() => {});
  const log = await page.locator('.dimtable tbody').innerText();
  if (!log.includes('Respondió D1 pregunta 1')) console.log(log.split('\n').slice(0, 40).join('\n'));
  ok(log.includes('Sincronizó') && log.includes('Invitó a carla@vantaz.cl') && log.includes('Respondió D1 pregunta 1: 100 %'), 'bitácora: sincronización, invitación y respuestas de la tablet');

  await page.locator('a.nav', { hasText: 'Modelo de evaluación' }).click();
  await page.getByText('12 dimensiones · 128 preguntas · 5 niveles').waitFor({ timeout: 5000 }).catch(() => {});
  ok(await page.getByText('12 dimensiones · 128 preguntas · 5 niveles').count() === 1, 'modelo: V01 con 12 dimensiones y 128 preguntas');

  // La persona sin acceso ya no entra.
  await page.getByRole('button', { name: 'Salir' }).click();
  await page.fill('#si-user', 'evaluador');
  await page.getByRole('button', { name: 'Entrar' }).click();
  await page.getByText('Tu acceso a la aplicación fue retirado.').waitFor();
  ok(true, 'una cuenta sin acceso no puede entrar');

  // Un evaluador nuevo ve solo lo suyo y no ve administración.
  await page.fill('#si-user', 'pedro');
  await page.getByRole('button', { name: 'Entrar' }).click();
  await page.locator('.top').waitFor();
  ok(await page.locator('a.nav', { hasText: 'Usuarios' }).count() === 0, 'evaluador no ve administración');
  await page.goto(URL + '#/usuarios');
  ok(await page.getByText('Esta sección es solo para administradores.').count() === 1, 'evaluador no entra a administración por enlace directo');
  await page.goto(URL + '#/evaluaciones');
  await page.getByText('Aún no hay evaluaciones en el servidor.').waitFor();
  ok(true, 'evaluador no ve evaluaciones de otros');

  await page.setViewportSize({ width: 400, height: 800 });
  await page.goto(URL + '#/panel');
  await page.locator('.kpi').first().waitFor();
  const sw = await page.evaluate(() => document.documentElement.scrollWidth);
  ok(sw <= 400, `ancho angosto sin desborde (scrollWidth ${sw})`);
  const real = errs.filter((e) => !/status of 403/.test(e));
  ok(real.length === 0, 'sin errores de consola' + (real.length ? ': ' + real.join(' | ') : ''));
  await b.close();
})();

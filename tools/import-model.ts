// Importa el modelo de evaluación desde el Excel (RF-01) y produce un catálogo versionado
// más un informe de validación. Si hay errores bloqueantes no escribe el catálogo.
//
// Uso: npm run import-model -- <ruta.xlsx> <versión> [salida.json]

import ExcelJS from 'exceljs';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { Dimension, DimensionCode, LevelDef, Model, Question } from '../packages/model/src/types';

type Issue = { level: 'error' | 'warning'; where: string; message: string };

const SHEET_RUBRIC = 'Rúbrica de Evaluación';
const SHEET_SCALE = 'Escala';
const SHEET_QUESTIONS = 'Preguntas';
const SHEET_LISTS = 'Listas Evaluación';
const SHEET_MATRIX = 'Matriz de Prioridades';

const RUBRIC_HEADERS: Record<string, string> = {
  C: 'Dimensión', D: 'Subdimensión', E: 'Cód. sub', F: 'Foco', G: 'Punto de la cadena causal',
  H: 'Riesgo', I: 'Evento no deseado', J: 'Control', K: 'Propósito del control', L: 'Criterio',
  M: 'N° Preg.', N: 'Pregunta', O: 'Evidencia posible (ejemplos)', P: 'Criterio 0%',
  Q: 'Criterio 25%', R: 'Criterio 50%', S: 'Criterio 75%', T: 'Criterio 100%',
  U: 'Nivel de evaluación', V: 'Tipo de evidencia', W: 'Método de evaluación',
  X: 'Consecuencia potencial', Y: 'Tipo de control',
};

function text(v: ExcelJS.CellValue): string | null {
  if (v == null) return null;
  if (typeof v === 'object') {
    if ('richText' in v) return v.richText.map((t) => t.text).join('').trim() || null;
    if ('result' in v) return text(v.result as ExcelJS.CellValue);
    if ('text' in v) return String(v.text).trim() || null;
  }
  const s = String(v).trim();
  return s === '' ? null : s;
}

const norm = (s: string | null) => (s ?? '').replace(/\s+/g, ' ').trim();

/** "D1. Gobernanza…", "D.2 Gestión…" → { code: "D2", name: "Gestión…" } */
export function parseDimensionLabel(label: string): { code: DimensionCode; name: string } | null {
  const m = label.match(/^D\.?\s?(\d+)\.?\s*(.+)$/);
  if (!m) return null;
  return { code: `D${Number(m[1])}` as DimensionCode, name: m[2]!.trim() };
}

export async function importModel(file: string, version: string) {
  const issues: Issue[] = [];
  const buf = readFileSync(file);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);

  for (const name of [SHEET_RUBRIC, SHEET_SCALE]) {
    if (!wb.getWorksheet(name)) issues.push({ level: 'error', where: name, message: 'Falta la hoja' });
  }
  if (issues.length) return { issues, model: null };

  const ru = wb.getWorksheet(SHEET_RUBRIC)!;
  for (const [col, expected] of Object.entries(RUBRIC_HEADERS)) {
    const got = norm(text(ru.getCell(`${col}1`).value));
    if (got !== expected) issues.push({ level: 'error', where: `${SHEET_RUBRIC}!${col}1`, message: `Se esperaba la columna "${expected}" y se encontró "${got}"` });
  }
  if (issues.length) return { issues, model: null };

  // --- Escala: niveles y descriptores ---
  const sc = wb.getWorksheet(SHEET_SCALE)!;
  const levelNames = ['C', 'D', 'E', 'F', 'G'].map((c) => norm(text(sc.getCell(`${c}5`).value)));
  const levels = [21, 22, 23, 24, 25].map((r, i) => {
    const upper = Number(text(sc.getCell(`J${r}`).value)) * 100;
    const color = norm(text(sc.getCell(`K${r}`).value));
    return { n: (i + 1) as LevelDef['n'], name: levelNames[i]!, upper: Math.round(upper * 100) / 100, color };
  }) as Model['levels'];
  levels.forEach((l, i) => {
    if (!l.name) issues.push({ level: 'error', where: `${SHEET_SCALE}!${'CDEFG'[i]}5`, message: 'Nivel sin nombre' });
    if (!Number.isFinite(l.upper)) issues.push({ level: 'error', where: `${SHEET_SCALE}!J${21 + i}`, message: 'Límite de nivel no numérico' });
  });
  if (levels[4].upper !== 100) issues.push({ level: 'warning', where: `${SHEET_SCALE}!J25`, message: 'El límite del Nivel 5 no es 100 %' });

  const descriptors = new Map<DimensionCode, Dimension['levelDescriptors']>();
  sc.eachRow((row, r) => {
    if (r < 6) return;
    const label = text(row.getCell('B').value);
    const parsed = label ? parseDimensionLabel(label) : null;
    if (!parsed) return;
    descriptors.set(parsed.code, ['C', 'D', 'E', 'F', 'G'].map((c) => norm(text(row.getCell(c).value))) as Dimension['levelDescriptors']);
  });

  // --- Rúbrica: dimensiones, subdimensiones y preguntas ---
  const dims = new Map<DimensionCode, Dimension>();
  const questions: Question[] = [];
  let current: { code: DimensionCode; name: string; label: string } | null = null;
  ru.eachRow((row, r) => {
    if (r === 1) return;
    const cell = (c: string) => text(row.getCell(c).value);
    const qText = cell('N');
    if (!qText) {
      if (row.actualCellCount > 0 && cell('C')) issues.push({ level: 'warning', where: `${SHEET_RUBRIC}!fila ${r}`, message: 'Fila con dimensión pero sin pregunta; se ignora' });
      return;
    }
    const dimLabel = cell('C');
    if (dimLabel) {
      const parsed = parseDimensionLabel(dimLabel);
      if (!parsed) { issues.push({ level: 'error', where: `${SHEET_RUBRIC}!C${r}`, message: `Dimensión no reconocida: "${dimLabel}"` }); return; }
      current = { ...parsed, label: dimLabel };
    }
    if (!current) { issues.push({ level: 'error', where: `${SHEET_RUBRIC}!fila ${r}`, message: 'Pregunta sin dimensión' }); return; }
    const cur: { code: DimensionCode; name: string; label: string } = current;
    if (!dims.has(cur.code)) {
      dims.set(cur.code, { code: cur.code, order: dims.size + 1, name: cur.name, sourceLabel: cur.label, subdimensions: [], levelDescriptors: descriptors.get(cur.code) ?? ['', '', '', '', ''] });
    }
    const dim = dims.get(cur.code)!;
    const subCode = cell('E');
    const subName = cell('D');
    if (subCode && !dim.subdimensions.some((s) => s.code === subCode)) dim.subdimensions.push({ code: subCode, name: subName ?? '' });
    const number = Number(cell('M'));
    if (!Number.isInteger(number) || number < 1) issues.push({ level: 'error', where: `${SHEET_RUBRIC}!M${r}`, message: 'N° de pregunta inválido' });
    const rubric = ['P', 'Q', 'R', 'S', 'T'].map((c) => cell(c) ?? '') as Question['rubric'];
    rubric.forEach((t, i) => { if (!t) issues.push({ level: 'error', where: `${SHEET_RUBRIC}!${'PQRST'[i]}${r}`, message: 'Criterio vacío' }); });
    if (new Set(rubric).size < 5) issues.push({ level: 'error', where: `${SHEET_RUBRIC}!P${r}:T${r}`, message: 'Criterios repetidos dentro de la pregunta' });
    questions.push({
      id: `D${cur.code.slice(1).padStart(2, '0')}-Q${String(number).padStart(2, '0')}`,
      dimension: cur.code, number, globalIndex: questions.length + 1,
      subdimension: subCode, criterion: cell('L') ?? '', text: qText,
      evidenceExamples: cell('O'), evidenceType: cell('V'), method: cell('W'), evaluationLevel: cell('U'),
      consequence: cell('X'), controlType: cell('Y'), focus: cell('F'), causalPoint: cell('G'), risk: cell('H'),
      unwantedEvent: cell('I'), control: cell('J'), controlPurpose: cell('K'), rubric,
    });
  });

  // --- Validaciones de consistencia ---
  const ids = new Set<string>();
  for (const q of questions) {
    if (ids.has(q.id)) issues.push({ level: 'error', where: q.id, message: 'Pregunta duplicada (misma dimensión y número)' });
    ids.add(q.id);
    if (!q.criterion) issues.push({ level: 'warning', where: q.id, message: 'Sin nombre de criterio' });
    if (!q.evidenceType) issues.push({ level: 'warning', where: q.id, message: 'Sin tipo de evidencia' });
  }
  for (const d of dims.values()) {
    if (!descriptors.has(d.code)) issues.push({ level: 'warning', where: d.code, message: 'Sin descriptores de nivel en la hoja Escala' });
    if (d.subdimensions.length === 0) issues.push({ level: 'warning', where: d.code, message: 'Dimensión sin subdimensiones' });
  }

  // Preguntas y Listas Evaluación deben repetir los mismos textos (hoy se copian a mano: D-07).
  const pr = wb.getWorksheet(SHEET_QUESTIONS);
  const li = wb.getWorksheet(SHEET_LISTS);
  if (pr && li) {
    questions.forEach((q, i) => {
      const pText = norm(text(pr.getCell(`C${i + 5}`).value));
      if (pText && pText !== norm(q.text)) issues.push({ level: 'warning', where: `${SHEET_QUESTIONS}!C${i + 5}`, message: `El texto difiere de la Rúbrica (${q.id})` });
      const lRow = ['B', 'C', 'D', 'E', 'F'].map((c) => norm(text(li.getCell(`${c}${i + 1}`).value)));
      if (lRow.some((t, j) => t !== norm(q.rubric[j]!))) issues.push({ level: 'warning', where: `${SHEET_LISTS}!fila ${i + 1}`, message: `Los criterios difieren de la Rúbrica (${q.id})` });
    });
  }
  const external = (wb.model as unknown as { definedNames?: unknown }).definedNames;
  if (JSON.stringify(external ?? '').includes('[')) issues.push({ level: 'warning', where: 'Nombres definidos', message: 'Hay referencias a libros externos; el catálogo no las usa' });

  const mx = wb.getWorksheet(SHEET_MATRIX);
  const labels = (from: number) => Object.fromEntries([0, 1, 2, 3, 4].map((k) => [Number(text(mx?.getCell(`B${from + k}`).value) ?? 5 - k), norm(text(mx?.getCell(`C${from + k}`).value))]));

  const model: Model = {
    id: version,
    title: 'Evaluación de madurez en la gestión de fatiga y somnolencia',
    source: { file: basename(file), importedAt: new Date().toISOString(), sha256: createHash('sha256').update(buf).digest('hex') },
    levels,
    dimensions: [...dims.values()],
    questions,
    priority: { impactLabels: labels(22), effortLabels: labels(28) },
  };
  return { issues, model };
}

async function main() {
  const [file, version, out] = process.argv.slice(2);
  if (!file || !version) { console.error('Uso: npm run import-model -- <ruta.xlsx> <versión> [salida.json]'); process.exit(2); }
  const { issues, model } = await importModel(file, version);
  const errors = issues.filter((i) => i.level === 'error');
  for (const i of issues) console.log(`${i.level === 'error' ? 'ERROR ' : 'AVISO '} ${i.where}: ${i.message}`);
  if (!model || errors.length) { console.error(`\n${errors.length} errores bloqueantes; no se escribió el catálogo.`); process.exit(1); }
  const subs = model.dimensions.reduce((a, d) => a + d.subdimensions.length, 0);
  console.log(`\nModelo ${model.id}: ${model.dimensions.length} dimensiones, ${subs} subdimensiones, ${model.questions.length} preguntas, ${model.questions.length * 5} criterios; ${issues.length} avisos.`);
  const target = out ?? `packages/model/catalog/${version.toLowerCase()}.json`;
  writeFileSync(target, JSON.stringify(model, null, 2) + '\n');
  console.log(`Catálogo escrito en ${target}`);
}

if (process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]))) main();

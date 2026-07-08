// ─── Excel brief parsing ───────────────────────────────────────────────────────
// Generic port of the source system's parse-brief logic: sheet-name keyword
// detection used to hardcode a client's brand name and product name
// ("SOFA MATRICES", "TARRITO"); replaced with a documented generic heuristic
// (sheet name contains MATRICES/BRIEF/CUADRO, or fall back to header content —
// a row containing both AUDIENCIA(S) and COPY, or the largest sheet). When the
// deterministic parser can't find a recognizable header, a single text-provider
// call interprets the raw rows — same design as the source system, just routed
// through the generic TextProvider contract instead of the Anthropic SDK.
import * as XLSX from 'xlsx';
import type { TextProvider } from '../../adapters/types.js';
import { FORMATS, dimToFormatId, normalizeKey } from './formats.js';

const SHEET_NAME_HINTS = ['MATRICES', 'BRIEF', 'CUADRO'];

function pickSheet(wb: XLSX.WorkBook, requireCopyHeader: boolean): { sheetName: string; rows: any[][] } {
    let sheetName = wb.SheetNames.find(n => SHEET_NAME_HINTS.some(kw => n.toUpperCase().includes(kw))) || wb.SheetNames[0];
    let rows: any[][] = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: '' }) as any[][];
    if (requireCopyHeader) {
        const hasCopyHeader = rows.slice(0, 30).some(r => r.some((c: any) => String(c).toUpperCase().includes('COPY')));
        if (!hasCopyHeader) {
            for (const sn of wb.SheetNames) {
                const r: any[][] = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, defval: '' });
                if (r.length > rows.length) { rows = r; sheetName = sn; }
            }
        }
    } else {
        for (const sn of wb.SheetNames) {
            const r: any[][] = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, defval: '' });
            if (r.length > rows.length) { rows = r; sheetName = sn; }
        }
    }
    return { sheetName, rows };
}

/**
 * AI fallback for briefs whose columns the deterministic parser can't
 * recognize (different agency's own column names, another language, no clear
 * header row). One text-provider call, not a replacement for the free
 * deterministic path above (which stays the normal path for the common case).
 */
async function parseWithAI(rows: any[][], text: TextProvider): Promise<any[] | null> {
    const tableText = rows.slice(0, 80)
        .map((row, i) => `[fila ${i}] ` + row.map((c: any) => String(c ?? '').slice(0, 200)).join(' | '))
        .join('\n');

    const prompt = `Este es un cuadro de materiales publicitarios de una agencia, sin un formato de columnas estándar — puede tener nombres de columna distintos, en otro idioma, o venir sin encabezados claros. Tu trabajo es leer las filas e identificar, para CADA pieza publicitaria real que encuentres, los siguientes campos:

- audience: el segmento/audiencia objetivo (texto corto)
- audienciaRef: descripción de las personas reales de ese segmento (si existe, si no dejar vacío)
- drivers: motivaciones/insights del segmento (si existe)
- tono: mood o tono (aspiracional, celebratorio, empático, urgente, motivacional, tranquilo, familiar, profesional — o vacío)
- variante: identificador A/B si existe
- observaciones: notas creativas adicionales
- copyFull: el copy/texto publicitario completo de esa pieza (headline + cuerpo + CTA, tal como venga)
- dimensions: el tamaño/formato en píxeles si se menciona (ej "1080x1080"), o el nombre de plataforma si no hay píxeles (ej "Instagram Feed")
- campaña, medio, formato: si existen esos datos

FILAS DEL ARCHIVO:
${tableText}

Ignorá filas vacías, de encabezado, o que no representen una pieza real. Devolvé SOLO JSON válido, sin markdown:
{ "pieces": [{ "audience": "", "audienciaRef": "", "drivers": "", "tono": "", "variante": "", "observaciones": "", "copyFull": "", "dimensions": "" , "campaña": "", "medio": "", "formato": ""}] }`;

    const responseText = await text.complete({ prompt, maxTokens: 8192, jsonMode: true });
    const jsonMatch = /\{[\s\S]*\}/.exec(responseText);
    if (!jsonMatch) return null;
    try {
        const parsed = JSON.parse(jsonMatch[0]);
        return Array.isArray(parsed.pieces) ? parsed.pieces : null;
    } catch { return null; }
}

export interface ParsedBriefResult {
    pieces: any[];
    total: number;
    debug: Record<string, unknown>;
    error?: string;
}

/** Parses an uploaded brief workbook into DCO-ready "pieces" (one per ad row). */
export async function parseBriefFile(buf: Buffer, text: TextProvider): Promise<ParsedBriefResult> {
    const wb = XLSX.read(buf, { type: 'buffer' });
    const { sheetName: usedSheet, rows } = pickSheet(wb, false);

    // ─── Header-row detection — multiple strategies ────────────────────────
    const HEADER_TERMS = ['AUDIENCIA', 'COPY', 'MEDIO', 'STATUS', 'FORMATO', 'CAMPANA'];
    let hdrIdx = -1;
    const colMap: Record<string, number> = {};

    for (let i = 0; i < Math.min(rows.length, 50); i++) {
        const row = rows[i];
        const cells = row.map((c: any) => String(c || '').toUpperCase().trim());
        const hasAud = cells.some(c => c.includes('AUDIENCIA'));
        const hasCopy = cells.some(c => c.includes('COPY'));
        if (hasAud && hasCopy) {
            hdrIdx = i;
            row.forEach((cell: any, idx: number) => { const key = normalizeKey(String(cell || '')); if (key) colMap[key] = idx; });
            break;
        }
    }
    if (hdrIdx === -1) {
        let bestScore = 1;
        for (let i = 0; i < Math.min(rows.length, 50); i++) {
            const cells = rows[i].map((c: any) => String(c || '').toUpperCase().trim());
            const score = HEADER_TERMS.filter(t => cells.some(c => c.includes(t))).length;
            if (score > bestScore) { bestScore = score; hdrIdx = i; }
        }
        if (hdrIdx >= 0) {
            rows[hdrIdx].forEach((cell: any, idx: number) => { const key = normalizeKey(String(cell || '')); if (key) colMap[key] = idx; });
        }
    }

    if (hdrIdx === -1) {
        const aiPieces = await parseWithAI(rows, text).catch((err: any) => {
            console.error('[dco] parse-brief AI fallback error:', err.message);
            return null;
        });
        if (aiPieces && aiPieces.length > 0) {
            const pieces = aiPieces.map((p: any, i: number) => {
                const dimRaw = String(p.dimensions || '').trim();
                const formatId = dimToFormatId(dimRaw) || 'feed_square';
                const fmt = FORMATS[formatId];
                return {
                    rowIndex: i,
                    audience: String(p.audience || '').trim(),
                    audienciaRef: String(p.audienciaRef || '').trim(),
                    drivers: String(p.drivers || '').trim(),
                    tono: String(p.tono || '').trim(),
                    variante: String(p.variante || '').trim(),
                    observaciones: String(p.observaciones || '').trim(),
                    copyPreview: String(p.copyFull || '').slice(0, 300),
                    copyFull: String(p.copyFull || '').trim(),
                    dimensions: dimRaw || `${fmt.width}×${fmt.height}`,
                    formatId,
                    formatLabel: `${fmt.width}×${fmt.height}`,
                    platform: fmt.platform,
                    campaña: String(p.campaña || '').trim(),
                    medio: String(p.medio || '').trim(),
                    formato: String(p.formato || '').trim(),
                };
            }).filter((p: any) => p.audience || p.copyFull);
            if (pieces.length > 0) return { pieces, total: pieces.length, debug: { usedSheet, aiFallback: true } };
        }
        const preview = rows.slice(0, 5).map((r, i) => ({ row: i, cells: r.slice(0, 10).map((c: any) => String(c || '').slice(0, 40)) }));
        return {
            pieces: [], total: 0,
            error: 'No se encontró el encabezado y no se pudo interpretar el archivo automáticamente. Asegúrate de que el archivo tenga columnas AUDIENCIAS y COPY, o filas con esa información reconocible.',
            debug: { sheets: wb.SheetNames, usedSheet, firstRows: preview },
        };
    }

    const findCol = (...candidates: string[]): number | undefined => {
        for (const k of candidates) if (colMap[k] !== undefined) return colMap[k];
        for (const ck of Object.keys(colMap)) for (const k of candidates) if (k.length >= 4 && ck.includes(k)) return colMap[ck];
        for (const ck of Object.keys(colMap)) for (const k of candidates) if (ck.length >= 4 && k.includes(ck)) return colMap[ck];
        return undefined;
    };

    const copyIdx          = findCol('COPY');
    const audIdx           = findCol('AUDIENCIAS', 'AUDIENCIA');
    const audRefIdx        = findCol('AUDIENCIASREFERENCIA', 'AUDIENCIAREFERENCIA', 'REFERENCIA');
    const driversIdx       = findCol('DRIVERS', 'DRIVER', 'MOTIVADORES');
    const tonoIdx          = findCol('TONO', 'MOOD', 'ENERGIA');
    const varianteIdx      = findCol('VARIANTE', 'VARIANT', 'VERSION', 'VERSIONAB', 'AB');
    const observacionesIdx = findCol('OBSERVACIONESCREATIVAS', 'OBSERVACIONES', 'NOTAS', 'NOTASCREATIVAS');
    const dimIdx            = findCol('TAMAOENPIXELES', 'TAMAO', 'PIXELES');
    const campañaIdx        = findCol('CAMPAA', 'CAMPANA');
    const medioIdx          = findCol('MEDIO');
    const formatoIdx        = findCol('FORMATODEANUNCIO', 'FORMATOANUNCIO', 'FORMATO');

    const pieces: any[] = [];
    for (let i = hdrIdx + 1; i < rows.length; i++) {
        const row = rows[i];
        const copy = copyIdx !== undefined ? String(row[copyIdx] || '').trim() : '';
        const aud = audIdx !== undefined ? String(row[audIdx] || '').trim() : '';
        if (!copy && !aud) continue;

        const dimRaw = dimIdx !== undefined ? String(row[dimIdx] || '').trim() : '';
        const campaña = campañaIdx !== undefined ? String(row[campañaIdx] || '').trim() : '';
        const medio = medioIdx !== undefined ? String(row[medioIdx] || '').trim() : '';
        const formato = formatoIdx !== undefined ? String(row[formatoIdx] || '').trim() : '';

        const formatId = dimToFormatId(dimRaw) || 'feed_square';
        const fmt = FORMATS[formatId];

        pieces.push({
            rowIndex: i,
            audience: aud,
            audienciaRef: audRefIdx !== undefined ? String(row[audRefIdx] || '').trim() : '',
            drivers: driversIdx !== undefined ? String(row[driversIdx] || '').trim() : '',
            tono: tonoIdx !== undefined ? String(row[tonoIdx] || '').trim() : '',
            variante: varianteIdx !== undefined ? String(row[varianteIdx] || '').trim() : '',
            observaciones: observacionesIdx !== undefined ? String(row[observacionesIdx] || '').trim() : '',
            copyPreview: copy.slice(0, 300),
            copyFull: copy,
            dimensions: dimRaw || `${fmt.width}×${fmt.height}`,
            formatId,
            formatLabel: `${fmt.width}×${fmt.height}`,
            platform: fmt.platform,
            campaña, medio, formato,
        });
    }

    return { pieces, total: pieces.length, debug: { usedSheet, hdrIdx, colsFound: Object.keys(colMap) } };
}

export interface BriefAudienceDigest {
    usedSheet: string;
    marca: string;
    campaña: string;
    mes: string;
    medios: string[];
    audiencias: { audiencia: string; audienciaRef: string; drivers: string; objetivo: string; territorio: string; copies: string[] }[];
}

/** Extracts existing audiences + their copies from an uploaded brief — feeds POST /generate-copies. */
export function extractBriefAudiences(buf: Buffer): BriefAudienceDigest {
    const wb = XLSX.read(buf, { type: 'buffer' });
    const { sheetName: usedSheet, rows } = pickSheet(wb, true);

    let hdrIdx = -1;
    const colMap: Record<string, number> = {};
    for (let i = 0; i < Math.min(rows.length, 50); i++) {
        const cells = rows[i].map((c: any) => String(c || '').toUpperCase().trim());
        if (cells.some(c => c.includes('AUDIENCIA')) && cells.some(c => c.includes('COPY'))) {
            hdrIdx = i;
            rows[i].forEach((cell: any, idx: number) => { const k = normalizeKey(String(cell || '')); if (k) colMap[k] = idx; });
            break;
        }
    }
    if (hdrIdx === -1) return { usedSheet, marca: '', campaña: '', mes: '', medios: [], audiencias: [] };

    const find = (...cands: string[]): number | undefined => {
        for (const k of cands) if (colMap[k] !== undefined) return colMap[k];
        for (const ck of Object.keys(colMap)) for (const k of cands) if (k.length >= 4 && ck.includes(k)) return colMap[ck];
        return undefined;
    };
    const ci = {
        copy: find('COPY'), aud: find('AUDIENCIAS', 'AUDIENCIA'),
        audRef: find('AUDIENCIASREFERENCIA', 'AUDIENCIAREFERENCIA'),
        drivers: find('DRIVERS', 'DRIVER'), obj: find('OBJETIVO'),
        terr: find('TERRITORIOPORTAFOLIO', 'TERRITORIO', 'PORTAFOLIO'),
        medio: find('MEDIO'), campana: find('CAMPAA', 'CAMPANA'), mes: find('MES'),
    };

    const map = new Map<string, { audiencia: string; audienciaRef: string; drivers: string; objetivo: string; territorio: string; copies: string[] }>();
    const medioSet = new Set<string>();
    let campaña = '', mes = '';
    for (let i = hdrIdx + 1; i < rows.length; i++) {
        const row = rows[i];
        const get = (idx?: number) => idx !== undefined ? String(row[idx] || '').trim() : '';
        const aud = get(ci.aud), copy = get(ci.copy);
        if (!aud && !copy) continue;
        if (!campaña) campaña = get(ci.campana);
        if (!mes) mes = get(ci.mes);
        const medio = get(ci.medio); if (medio) medioSet.add(medio);
        const key = aud || '—';
        if (!map.has(key)) map.set(key, { audiencia: aud, audienciaRef: get(ci.audRef), drivers: get(ci.drivers), objetivo: get(ci.obj), territorio: get(ci.terr), copies: [] });
        const entry = map.get(key)!;
        if (!entry.audienciaRef) entry.audienciaRef = get(ci.audRef);
        if (!entry.drivers) entry.drivers = get(ci.drivers);
        if (copy && entry.copies.length < 6) entry.copies.push(copy.slice(0, 600));
    }
    const marca = usedSheet.replace(/MATRICES/i, '').trim();
    return { usedSheet, marca, campaña, mes, medios: Array.from(medioSet), audiencias: Array.from(map.values()) };
}

/** Updates an uploaded brief in place with STATUS/FECHA SALIDA and (optionally) a video-prompt column, preserving original styling. */
export function updateBriefStatus(
    buf: Buffer,
    doneRowIndices: number[],
    videoPromptsMap: Record<number, string>,
): Buffer {
    const wb = XLSX.read(buf, { type: 'buffer', cellStyles: true });
    const { sheetName } = pickSheet(wb, false);
    const ws = wb.Sheets[sheetName];
    const rows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    const today = new Date().toLocaleDateString('es-CO', { day: '2-digit', month: '2-digit', year: 'numeric' });

    let hdrIdx = -1;
    const colMap: Record<string, number> = {};
    for (let i = 0; i < Math.min(rows.length, 15); i++) {
        const row = rows[i];
        if (row.some((c: any) => String(c).toUpperCase().includes('STATUS'))) {
            hdrIdx = i;
            row.forEach((cell: any, idx: number) => { const key = normalizeKey(String(cell || '')); if (key) colMap[key] = idx; });
            break;
        }
    }

    const fechaSalidaIdx = colMap['FECHASALIDA'];
    const statusIdx = colMap['STATUS'];
    const range = ws['!ref'] ? XLSX.utils.decode_range(ws['!ref']) : { s: { r: 0, c: 0 }, e: { r: 0, c: 0 } };

    const promptVideoKey = normalizeKey('PROMPT VIDEO 15s');
    let promptVideoIdx = colMap[promptVideoKey];
    if (promptVideoIdx === undefined && hdrIdx >= 0) {
        promptVideoIdx = range.e.c + 1;
        const hdrRef = XLSX.utils.encode_cell({ r: hdrIdx, c: promptVideoIdx });
        ws[hdrRef] = { v: 'PROMPT VIDEO 15s', t: 's' };
        range.e.c = promptVideoIdx;
    }

    for (const rowIdx of doneRowIndices) {
        if (fechaSalidaIdx !== undefined) {
            const ref = XLSX.utils.encode_cell({ r: rowIdx, c: fechaSalidaIdx });
            ws[ref] = { v: today, t: 's' };
            range.e.r = Math.max(range.e.r, rowIdx);
            range.e.c = Math.max(range.e.c, fechaSalidaIdx);
        }
        if (statusIdx !== undefined) {
            const ref = XLSX.utils.encode_cell({ r: rowIdx, c: statusIdx });
            ws[ref] = { v: 'PENDIENTE DE APROBACIÓN', t: 's' };
            range.e.r = Math.max(range.e.r, rowIdx);
            range.e.c = Math.max(range.e.c, statusIdx);
        }
        if (promptVideoIdx !== undefined && videoPromptsMap[rowIdx]) {
            const ref = XLSX.utils.encode_cell({ r: rowIdx, c: promptVideoIdx });
            ws[ref] = { v: videoPromptsMap[rowIdx], t: 's' };
            range.e.r = Math.max(range.e.r, rowIdx);
            range.e.c = Math.max(range.e.c, promptVideoIdx);
        }
    }

    ws['!ref'] = XLSX.utils.encode_range(range);
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', cellStyles: true }) as Buffer;
}

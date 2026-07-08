// ─── Excel template + cuadro-de-materiales export ─────────────────────────────
// Generic port: the source system's template had one client's brand name baked
// into the sheet title and a supplement-brand example row ("Complejo B"). Both
// removed — this produces a brand-neutral starter template + export sheet.
import ExcelJS from 'exceljs';

// Column order for both the downloadable template and the generated "cuadro de
// materiales" export — generic, industry-standard brief columns (no client name).
export const CUADRO_HEADERS = [
    '# PIEZAS', 'MES', 'CAMPAÑA', 'TERRITORIO/ PORTAFOLIO', 'REFERENCIA', 'AUDIENCIAS',
    'AUDIENCIAS REFERENCIA', 'DRIVERS', 'MEDIO', 'Formato de Anuncio', 'Creativo',
    'Tamaño (en pixeles)', 'Formato', 'Peso', 'Texto', 'OBJETIVO', 'geografía',
    'CREATIVO CONCEPTO', 'IMAGEN O VIDEO', 'COPY', 'FECHA INICIO', 'FECHA FINAL',
    'FECHA SALIDA', 'STATUS', '(LINK DRIVE)', 'COMENTARIOS',
    'TONO', 'VARIANTE', 'OBSERVACIONES CREATIVAS',
];

const RED_HEADER = 'E06C75';
const RED_AI = 'C0392B';
const RED_AUTO = '7F8C8D';
const DESC_BG = 'F9EBEA';
const EX_BG = 'FDFEFE';
const WHITE = 'FFFFFF';

function styleHeader(cell: ExcelJS.Cell, bgHex: string) {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + bgHex } };
    cell.font = { bold: true, color: { argb: 'FF' + WHITE }, size: 10, name: 'Calibri' };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = {
        top: { style: 'thin', color: { argb: 'FFFFFFFF' } },
        bottom: { style: 'thin', color: { argb: 'FFFFFFFF' } },
        left: { style: 'thin', color: { argb: 'FFFFFFFF' } },
        right: { style: 'thin', color: { argb: 'FFFFFFFF' } },
    };
}
function styleDesc(cell: ExcelJS.Cell) {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + DESC_BG } };
    cell.font = { italic: true, color: { argb: 'FF555555' }, size: 8, name: 'Calibri' };
    cell.alignment = { vertical: 'top', horizontal: 'left', wrapText: true };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FFE0E0E0' } } };
}
function styleExample(cell: ExcelJS.Cell) {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + EX_BG } };
    cell.font = { color: { argb: 'FF333333' }, size: 9, name: 'Calibri' };
    cell.alignment = { vertical: 'top', horizontal: 'left', wrapText: true };
}

/** Builds the downloadable "MATRICES" brief template — 3 sheets: data grid, valid formats, usage guide. */
export async function buildTemplateWorkbook(): Promise<Buffer> {
    const wbx = new ExcelJS.Workbook();
    wbx.creator = 'DCO Studio';
    wbx.created = new Date();

    // ── Sheet 1: MATRICES ──────────────────────────────────────────────────
    const ws1 = wbx.addWorksheet('MATRICES', { views: [{ state: 'frozen', ySplit: 2 }] });

    const columns: { header: string; key: string; width: number; type: 'normal' | 'ai' | 'auto' }[] = [
        { header: 'PIEZAS',                  key: 'piezas',   width: 10,  type: 'normal' },
        { header: 'MES',                     key: 'mes',      width: 12,  type: 'normal' },
        { header: 'CAMPAÑA',                 key: 'campana',  width: 28,  type: 'normal' },
        { header: 'TERRITORIO/ PORTAFOLIO',  key: 'terr',     width: 24,  type: 'normal' },
        { header: 'REFERENCIA',              key: 'ref',      width: 16,  type: 'normal' },
        { header: 'AUDIENCIAS',              key: 'aud',      width: 24,  type: 'normal' },
        { header: 'AUDIENCIAS REFERENCIA',   key: 'audref',   width: 38,  type: 'normal' },
        { header: 'DRIVERS',                 key: 'drivers',  width: 38,  type: 'normal' },
        { header: 'TONO',                    key: 'tono',     width: 18,  type: 'ai'     },
        { header: 'VARIANTE',                key: 'var',      width: 12,  type: 'ai'     },
        { header: 'MEDIO',                   key: 'medio',    width: 18,  type: 'normal' },
        { header: 'Formato de Anuncio',      key: 'fmtnom',   width: 20,  type: 'normal' },
        { header: 'Creativo',                key: 'creativo', width: 18,  type: 'normal' },
        { header: 'Tamaño (en pixeles)',     key: 'tamano',   width: 20,  type: 'normal' },
        { header: 'Formato',                 key: 'formato',  width: 16,  type: 'normal' },
        { header: 'Peso',                    key: 'peso',     width: 10,  type: 'normal' },
        { header: 'Texto',                   key: 'texto',    width: 20,  type: 'normal' },
        { header: 'OBJETIVO',                key: 'obj',      width: 16,  type: 'normal' },
        { header: 'geografía',               key: 'geo',      width: 16,  type: 'normal' },
        { header: 'CREATIVO CONCEPTO',       key: 'concepto', width: 26,  type: 'normal' },
        { header: 'IMAGEN O VIDEO',          key: 'imgvid',   width: 14,  type: 'normal' },
        { header: 'COPY',                    key: 'copy',     width: 52,  type: 'normal' },
        { header: 'OBSERVACIONES CREATIVAS', key: 'obs',      width: 40,  type: 'ai'     },
        { header: 'FECHA INICIO',            key: 'finicio',  width: 16,  type: 'normal' },
        { header: 'FECHA FINAL',             key: 'ffinal',   width: 16,  type: 'normal' },
        { header: 'FECHA SALIDA',            key: 'fsalida',  width: 20,  type: 'auto'   },
        { header: 'STATUS',                  key: 'status',   width: 24,  type: 'auto'   },
        { header: '(LINK DRIVE)',            key: 'link',     width: 30,  type: 'normal' },
        { header: 'COMENTARIOS',             key: 'coment',   width: 28,  type: 'normal' },
    ];

    ws1.columns = columns.map(c => ({ key: c.key, width: c.width }));
    ws1.getRow(1).height = 36;
    ws1.getRow(2).height = 60;
    ws1.getRow(3).height = 80;

    const headerRow = ws1.getRow(1);
    columns.forEach((col, i) => {
        const cell = headerRow.getCell(i + 1);
        cell.value = col.header;
        const bg = col.type === 'ai' ? RED_AI : col.type === 'auto' ? RED_AUTO : RED_HEADER;
        styleHeader(cell, bg);
    });

    const descriptions = [
        'Número de la pieza. Ej: 1, 2, 3...',
        'Mes de pauta. Ej: Mayo 2025',
        'Nombre del vuelo o campaña.',
        'Territorio o portafolio. Ej: Nacional / Región X',
        'Referencia interna. Ej: REF-001',
        '★ CRÍTICO\nNombre del segmento. Define la escena generada.',
        '★ CRÍTICO\nPersonas reales del segmento. Enriquece la escena.',
        '★ CRÍTICO\nMotivaciones del segmento. Alimenta el contexto emocional.',
        '★ AI OPCIONAL\nMood: aspiracional / celebratorio / empático / urgente / motivacional / tranquilo / familiar / profesional',
        '★ AI OPCIONAL\nVersión A/B. Ej: A, B, C.',
        'Plataforma. Ej: Meta, Programática, TikTok',
        'Nombre del formato.',
        'Código del creativo.',
        '★ CRÍTICO\nDimensiones en píxeles. Ver hoja FORMATOS VÁLIDOS.',
        'Nombre del formato. Ej: Portrait 4:5',
        'Peso máx. Ej: 2MB',
        'Texto visual adicional.',
        'Objetivo. Ej: Awareness, Conversión',
        'Región. Ej: Nacional',
        'Concepto creativo del batch.',
        'Imagen o Video.',
        '★ CRÍTICO\nEstructura:\nCOPY PRINCIPAL: [titular]\nDESARROLLO: [cuerpo]\nCIERRE: [CTA]',
        '★ AI OPCIONAL\nNotas al AI por pieza. Ej: "No mostrar el producto cerca del agua"',
        'Fecha de inicio de pauta.',
        'Fecha de fin de pauta.',
        '⚙ AUTOMÁTICO\nLo escribe el sistema.',
        '⚙ AUTOMÁTICO\nLo escribe el sistema.',
        'Link del Drive con archivos finales.',
        'Comentarios del equipo o cliente.',
    ];
    const descRow = ws1.getRow(2);
    descriptions.forEach((d, i) => { const cell = descRow.getCell(i + 1); cell.value = d; styleDesc(cell); });

    const exampleValues = [
        '1', 'Junio 2025', 'Campaña Lanzamiento Q2', 'Nacional', 'REF-JUN-001',
        'Profesionales Urbanos',
        'Adultos 25-40, profesionales, urbanos',
        'Buscan un producto confiable que se adapte a su rutina diaria',
        'aspiracional', 'A', 'Meta', 'Feed Portrait 4:5', 'REF-ENE-001',
        '1080x1350', 'Portrait 4:5', '2MB', '', 'Awareness', 'Nacional',
        'Hecho para tu día a día', 'Imagen',
        'COPY PRINCIPAL: La marca que te acompaña\nDESARROLLO: Diseñado para adaptarse a tu rutina\nCIERRE: Descúbrelo hoy.',
        '', '01/06/2025', '30/06/2025', '', '', '', '',
    ];
    const exRow = ws1.getRow(3);
    exampleValues.forEach((v, i) => { const cell = exRow.getCell(i + 1); cell.value = v; styleExample(cell); });

    // ── Sheet 2: valid formats ─────────────────────────────────────────────
    const ws2 = wbx.addWorksheet('FORMATOS VÁLIDOS');
    ws2.columns = [{ width: 22 }, { width: 26 }, { width: 42 }];
    const fmtHeaders = ws2.getRow(1);
    ['TAMAÑO (EN PIXELES)', 'NOMBRE DEL FORMATO', 'PLATAFORMA / USO'].forEach((h, i) => {
        const cell = fmtHeaders.getCell(i + 1);
        cell.value = h;
        styleHeader(cell, RED_HEADER);
    });
    ws2.getRow(1).height = 30;
    const fmtRows = [
        ['1080x1080', 'Feed Square 1:1',      'Meta Feed cuadrado'],
        ['1080x1350', 'Feed Portrait 4:5',    'Meta Feed vertical'],
        ['1080x1920', 'Stories / Reels 9:16', 'Instagram Stories, Reels, TikTok'],
        ['970x250',   'Billboard 970×250',    'Programática — banner horizontal'],
        ['160x600',   'Skyscraper 160×600',   'Programática — banner lateral'],
        ['300x600',   'Half Page 300×600',    'Programática — media página'],
        ['300x250',   'MREC 300×250',         'Programática — rectángulo medio'],
        ['1200x628',  'Landscape 1200×628',   'Google Display, LinkedIn, Twitter'],
        ['1200x630',  'Landscape 1200×630',   'Alias de 1200×628 (también válido)'],
    ];
    fmtRows.forEach((r, ri) => {
        const row = ws2.getRow(ri + 2);
        r.forEach((v, ci) => {
            const cell = row.getCell(ci + 1);
            cell.value = v;
            cell.font = { size: 10, name: 'Calibri' };
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ri % 2 === 0 ? 'FFF9EBEA' : 'FFFFFFFF' } };
            cell.alignment = { vertical: 'middle', horizontal: ci === 0 ? 'center' : 'left' };
        });
        row.height = 20;
    });

    // ── Sheet 3: usage guide ───────────────────────────────────────────────
    const ws3 = wbx.addWorksheet('GUÍA DE USO');
    ws3.columns = [{ width: 90 }];
    const guiaLines: [string, boolean][] = [
        ['GUÍA DE USO — DCO STUDIO', true],
        ['', false],
        ['COLUMNAS CRÍTICAS (el sistema las lee automáticamente):', true],
        ['  AUDIENCIAS            → Selecciona/inspira la escena según el segmento', false],
        ['  AUDIENCIAS REFERENCIA → Describe las personas reales del segmento', false],
        ['  DRIVERS               → Motivaciones del segmento', false],
        ['  COPY                  → Copy completo — ver estructura abajo', false],
        ['  Tamaño (en pixeles)   → Define el formato — ver hoja FORMATOS VÁLIDOS', false],
        ['  STATUS, FECHA SALIDA  → Los escribe el sistema automáticamente', false],
        ['', false],
        ['COLUMNAS AI OPCIONALES (mejoran los resultados, no son requeridas):', true],
        ['  TONO                  → Mood de la escena (aspiracional / celebratorio / empático / urgente / motivacional / tranquilo / familiar / profesional)', false],
        ['  VARIANTE              → Identificador A/B — aparece en la tarjeta de generación', false],
        ['  OBSERVACIONES CREATIVAS → Notas al AI por pieza — restricciones específicas', false],
        ['', false],
        ['ESTRUCTURA DEL COPY:', true],
        ['  COPY PRINCIPAL: [titular principal]', false],
        ['  DESARROLLO: [cuerpo]', false],
        ['  CIERRE: [llamado a la acción]', false],
        ['', false],
        ['DETECCIÓN DE HOJA Y ENCABEZADOS:', true],
        ['  El sistema busca la hoja cuyo nombre contenga MATRICES, BRIEF o CUADRO (heurística genérica, no depende del nombre de ningún cliente).', false],
        ['  Si no encuentra un nombre reconocible, usa la hoja con más filas.', false],
        ['  Detecta el encabezado por contenido: busca una fila con AUDIENCIA(S) y COPY entre sus celdas.', false],
        ['  Si tampoco encuentra eso, interpreta el archivo con IA a partir de las filas crudas.', false],
    ];
    guiaLines.forEach(([text, bold], i) => {
        const row = ws3.getRow(i + 1);
        const cell = row.getCell(1);
        cell.value = text;
        cell.font = { bold, size: bold ? 11 : 10, name: 'Calibri', color: { argb: bold ? 'FF' + RED_HEADER : 'FF333333' } };
        cell.alignment = { wrapText: true };
        if (bold) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF9EBEA' } };
        row.height = 18;
    });

    const buf = await wbx.xlsx.writeBuffer();
    return Buffer.from(buf);
}

/** Builds a filled "cuadro de materiales" export sheet for the given pieces. */
export async function buildCuadroWorkbook(pieces: any[], meta: { marca?: string }): Promise<Buffer> {
    const wbx = new ExcelJS.Workbook();
    wbx.creator = 'DCO Studio';
    wbx.created = new Date();
    const sheetName = `${(meta.marca || 'CUADRO').toUpperCase()} MATRICES`.slice(0, 31);
    const ws = wbx.addWorksheet(sheetName, { views: [{ state: 'frozen', ySplit: 1 }] });

    ws.getColumn(1).width = 3;
    CUADRO_HEADERS.forEach((h, i) => {
        const col = ws.getColumn(i + 2);
        col.width = h === 'COPY' ? 52 : h === 'AUDIENCIAS REFERENCIA' || h === 'DRIVERS' ? 38 : h.length > 16 ? 24 : 16;
    });
    const headerRow = ws.getRow(1);
    headerRow.height = 34;
    const AI_COLS = new Set(['TONO', 'VARIANTE', 'OBSERVACIONES CREATIVAS']);
    CUADRO_HEADERS.forEach((h, i) => {
        const cell = headerRow.getCell(i + 2);
        cell.value = h;
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + (AI_COLS.has(h) ? RED_AI : RED_HEADER) } };
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10, name: 'Calibri' };
        cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    });

    pieces.forEach((p, ri) => {
        const row = ws.getRow(ri + 2);
        const vals = [
            p.piezas ?? (ri + 1), p.mes || '', p.campana || p.campaña || '', p.territorio || 'NACIONAL',
            p.referencia || '', p.audiencia || '', p.audienciaRef || '', p.drivers || '',
            p.medio || '', p.formatoAnuncio || 'Link Ad', p.creativo || '', p.tamano || '1080x1080',
            p.formato || 'Feed Square 1:1', p.peso || '80KB', p.texto || '', p.objetivo || 'Awareness',
            p.geografia || 'NACIONAL', p.concepto || '', p.imagenVideo || 'Imagen', p.copyFull || '',
            p.fechaInicio || '', p.fechaFinal || '', p.fechaSalida || '', p.status || '', p.linkDrive || '',
            p.comentarios || (p.nuevaAudiencia ? 'Audiencia nueva sugerida por IA' : ''),
            p.tono || '', p.variante || '', p.observaciones || '',
        ];
        vals.forEach((v, i) => {
            const cell = row.getCell(i + 2);
            cell.value = v as any;
            cell.font = { size: 9, name: 'Calibri' };
            cell.alignment = { vertical: 'top', horizontal: 'left', wrapText: true };
            cell.border = { bottom: { style: 'thin', color: { argb: 'FFE0E0E0' } } };
        });
    });

    const out = await wbx.xlsx.writeBuffer();
    return Buffer.from(out);
}

import React, { useState, useRef, useCallback } from 'react';
import { Upload, X, Download, Loader2, CheckCircle2, AlertCircle, Sparkles, Image as ImageIcon, FileText, Table2, Check, Plus } from 'lucide-react';

import type {
    DCOStudioProps, GenStatus, BriefRow, ProfileEntry, FormatResult,
    FixedZoneLabel, ZoneLabel, RecreateCopy,
} from './dco-studio/types';
import {
    FORMATS, KV_FORMAT_OPTIONS, GPT_UNSUPPORTED_FORMATS, PROXY_FORMAT_FOR_BANNER,
    RECREATE_FORMAT_OPTIONS, translateQaIssue,
} from './dco-studio/constants';
import { shadeColor, hexToRgba } from './dco-studio/color';
import { FormatShape } from './dco-studio/FormatShape';
import { authHeaders, resolveApiBase } from './dco-studio/api';
import { consumeSSE, fetchWithColdStartRetry, extractErrorDetail } from './dco-studio/useSSEStream';

// ─── Componente principal ─────────────────────────────────────────────────────
export default function DCOStudio(props: DCOStudioProps) {
    const { apiKeyHeader, currentUserEmail } = props;
    // Base URL del backend — configurable, sin URL de producción ajena como fallback.
    const API_BASE = resolveApiBase(props.apiBaseUrl);
    // Color de acento de la HERRAMIENTA (header, botones, bordes activos) — configurable
    // vía prop, con un azul neutro por default. Todo lo que en el original era el literal
    // "#E30613" (rojo de MUSE) repetido en decenas de estilos ahora deriva de esta única
    // constante, para que ningún color de marca ajeno quede hardcodeado.
    const ACCENT = props.brandColor || '#2563EB';
    const ACCENT_LIGHT = shadeColor(ACCENT, 25);
    const ACCENT_DARK = shadeColor(ACCENT, -20);
    const accentA = (alpha: number) => hexToRgba(ACCENT, alpha);
    const authedHeaders = (extra?: Record<string, string>) => authHeaders({ apiKeyHeader }, extra);

    const [mode, setMode] = useState<'manual' | 'brief' | 'copys' | 'carousel' | 'auto'>('manual');
    // Por default solo se ve el flujo simple (KV → generar variantes) — Excel/brief/
    // audiencias/carrusel quedan atrás de un toggle explícito, para no abrumar a un
    // usuario nuevo con 3-4 modos antes de haber generado ni una pieza.
    const [showAdvancedModes, setShowAdvancedModes] = useState(false);

    // ── Modo Carrusel: historia multi-slide con personaje consistente ──
    const [carouselNarrative, setCarouselNarrative]   = useState('');
    const [carouselFormat, setCarouselFormat]         = useState<'1:1' | '4:5'>('1:1');
    const [carouselSlideCount, setCarouselSlideCount] = useState(4);
    const [carouselStatus, setCarouselStatus]         = useState<'idle' | 'generating' | 'done' | 'error'>('idle');
    const [carouselBeats, setCarouselBeats]           = useState<{ sceneDesc: string; copy: { headline: string; cta: string } }[]>([]);
    const [carouselSlides, setCarouselSlides]         = useState<Record<number, { imageBase64: string; mimeType: string; score: number; status: 'generating' | 'done' | 'error' }>>({});
    const [carouselError, setCarouselError]           = useState('');

    // ── Modo Copys IA: genera copys nuevos a partir de un cuadro base ──
    const [copyBriefFile, setCopyBriefFile]   = useState<File | null>(null);
    const [copyIdentity, setCopyIdentity]     = useState<any | null>(null);
    const [copyPieces, setCopyPieces]         = useState<any[]>([]);
    const [copyLoading, setCopyLoading]       = useState(false);
    const [copyError, setCopyError]           = useState('');
    const [variantsPerAudience, setVariantsPerAudience] = useState(3);
    const [newAudiencesCount, setNewAudiencesCount]     = useState(2);
    const [copyInstructions, setCopyInstructions]       = useState('');
    const copyBriefInputRef = useRef<HTMLInputElement>(null);

    // ── Copys IA: fuente "desde audiencias" — form directo, sin subir Excel.
    // Cantidad libre (el usuario agrega/quita las que necesite, no un número fijo).
    const [copySource, setCopySource] = useState<'excel' | 'audiences'>('excel');
    const [audienceList, setAudienceList] = useState<{ name: string; ageRange: string; interests: string; characterId?: string; wardrobe?: string; headwear?: string; environment?: string }[]>([
        { name: '', ageRange: '', interests: '' },
    ]);
    const [suggestingAudiences, setSuggestingAudiences] = useState(false);

    // ── Recrear con IA (outpainting del KV real vía GPT-image) — a diferencia del modo
    // Brief (foto nueva + texto por código), esto parte de la foto REAL del KV y la
    // adapta a otro formato/audiencia (cambia texto, vestuario/accesorios/entorno del
    // personaje), manteniendo producto/logos/layout. Resultados por pieza × formato.
    // Todos los formatos pasan por /recreate-formats — el backend decide el proveedor
    // (GPT-image para los estándar, Gemini como respaldo para banners que GPT no soporta
    // por su límite de aspect ratio/píxeles), así que el frontend no necesita distinguir...
    // EXCEPTO cuando un banner además lleva copy/audiencia nueva: ese caso se resuelve con
    // 2 solicitudes cortas separadas (nunca una sola conexión larga, que puede superar el
    // timeout de un proxy en producción y dejar la pieza "cargando" para siempre):
    // paso 1 (GPT hace el cambio creativo en un formato proxy soportado) + paso 2
    // (POST /resize-with-gemini, Gemini solo extiende esa imagen ya finalizada).
    const [recreateFormatIds, setRecreateFormatIds] = useState<string[]>(['story_vertical']);
    const [recreating, setRecreating] = useState<Record<number, boolean>>({});
    const [recreateResults, setRecreateResults] = useState<Record<number, Record<string, { status: string; imageBase64?: string; mimeType?: string; error?: string }>>>({});

    function base64ToBlob(b64: string, mime: string): Blob {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new Blob([bytes], { type: mime });
    }

    // POST a /recreate-formats para UN solo formato y devuelve su resultado (o lanza con
    // el mensaje de error) — helper compartido para no repetir el parseo de SSE.
    async function runRecreateFormatsSSE(fd: FormData): Promise<{ imageBase64: string; mimeType: string }> {
        const res = await fetch(`${API_BASE}/api/dco/recreate-formats`, { method: 'POST', headers: authedHeaders(), body: fd });
        if (!res.ok || !res.body) throw new Error(await extractErrorDetail(res));
        let result: { imageBase64: string; mimeType: string } | null = null;
        let errorMsg: string | null = null;
        await consumeSSE(res, ev => {
            if (ev.type === 'result') result = { imageBase64: ev.imageBase64, mimeType: ev.mimeType };
            if (ev.type === 'error') errorMsg = ev.error;
        });
        if (result) return result;
        throw new Error(errorMsg || 'Sin resultado');
    }

    // Orquesta UN formato: directo (1 solicitud) si es estándar, o si es banner sin
    // cambio creativo; 2 solicitudes separadas si es banner CON copy/audiencia nueva.
    async function recreateOneFormat(targetFormatId: string, copyPayload: RecreateCopy | null, wardrobe: string, headwear: string, environment: string, varyScene: boolean = false): Promise<{ imageBase64: string; mimeType: string }> {
        const isBanner = targetFormatId.startsWith('banner_');
        const hasCreative = !!(copyPayload && (copyPayload.headline || copyPayload.subhead || copyPayload.cta || copyPayload.beneficios?.length)) || !!(wardrobe || headwear || environment) || varyScene;

        const buildFd = (formatId: string) => {
            const fd = new FormData();
            fd.append('kvImage', kvFile!);
            fd.append('formats', formatId);
            if (copyPayload) fd.append('copy', JSON.stringify(copyPayload));
            if (wardrobe) fd.append('characterWardrobe', wardrobe);
            if (headwear) fd.append('characterHeadwear', headwear);
            if (environment) fd.append('environment', environment);
            if (varyScene) fd.append('varyScene', 'true');
            return fd;
        };

        if (isBanner && hasCreative) {
            // Paso 1 — GPT hace el trabajo creativo en el formato proxy soportado.
            const proxyFormatId = PROXY_FORMAT_FOR_BANNER[targetFormatId] || 'feed_square';
            const stage1 = await runRecreateFormatsSSE(buildFd(proxyFormatId));

            // Paso 2 — Gemini SOLO extiende esa imagen ya finalizada al tamaño banner real.
            const targetFmt = FORMATS.find(f => f.id === targetFormatId)!;
            const [tw, th] = targetFmt.dims.split('×').map(s => parseInt(s.replace(/\D/g, '')));
            const fd2 = new FormData();
            fd2.append('image', base64ToBlob(stage1.imageBase64, stage1.mimeType), 'proxy.png');
            fd2.append('width', String(tw));
            fd2.append('height', String(th));
            const res2 = await fetch(`${API_BASE}/api/dco/resize-with-gemini`, { method: 'POST', headers: authedHeaders(), body: fd2 });
            const data2 = await res2.json();
            if (!res2.ok) throw new Error(data2.error || 'Error en el paso 2 (Gemini)');
            return { imageBase64: data2.imageBase64, mimeType: data2.mimeType };
        }

        // Camino directo — 1 sola solicitud (formato estándar, o banner sin cambio creativo).
        return runRecreateFormatsSSE(buildFd(targetFormatId));
    }

    const recreateWithAI = async (idx: number) => {
        const p = copyPieces[idx];
        if (!kvFile || !p || recreating[idx] || recreateFormatIds.length === 0) return;
        setRecreating(prev => ({ ...prev, [idx]: true }));
        setRecreateResults(prev => ({ ...prev, [idx]: {} }));
        const copyPayload: RecreateCopy = {
            headline: p.copy_principal || '',
            subhead: p.desarrollo || '',
            beneficios: Array.isArray(p.beneficios) ? p.beneficios : [],
            cta: p.cierre || '',
        };
        // Máximo 2 en simultáneo — mismo límite que el envío masivo a Enviar al DCO, para
        // no disparar de golpe una llamada por cada formato seleccionado (riesgo real de
        // rate-limit si se eligen varios formatos a la vez para una sola pieza).
        await runWithConcurrency(recreateFormatIds, 2, async (fid) => {
            setRecreateResults(prev => ({ ...prev, [idx]: { ...prev[idx], [fid]: { status: 'generating' } } }));
            try {
                const result = await recreateOneFormat(fid, copyPayload, p.wardrobe || '', p.headwear || '', p.environment || '', !!p.varyScene);
                setRecreateResults(prev => ({ ...prev, [idx]: { ...prev[idx], [fid]: { status: 'done', ...result } } }));
            } catch (e: any) {
                setRecreateResults(prev => ({ ...prev, [idx]: { ...prev[idx], [fid]: { status: 'error', error: e.message || 'Error' } } }));
            }
        });
        setRecreating(prev => ({ ...prev, [idx]: false }));
    };

    // KV
    const [kvFile, setKvFile]         = useState<File | null>(null);
    const [kvPreview, setKvPreview]   = useState<string>('');
    // Product images (múltiples)
    const [productFiles, setProductFiles]         = useState<File[]>([]);
    const [productPreviews, setProductPreviews]   = useState<string[]>();
    // Logo de marca (opcional) — imagen dedicada, separada del KV, para reproducirlo fiel
    const [logoFile, setLogoFile]         = useState<File | null>(null);
    const [logoPreview, setLogoPreview]   = useState<string>('');
    // Logo del conglomerado (opcional) — ej. "Una empresa de [Grupo X]", mismo patrón
    // que el logo de marca: imagen dedicada para reproducirlo fiel, no reinventado.
    const [conglomerateLogoFile, setConglomerateLogoFile]       = useState<File | null>(null);
    const [conglomerateLogoPreview, setConglomerateLogoPreview] = useState<string>('');
    // Badges/sellos adicionales (opcional, cualquier cantidad) — genérico para CUALQUIER
    // marca: badge de fabricante, íconos de cumplimiento, sello de certificación, etc.
    // Mismo patrón que logo/conglomerado: imagen dedicada que se compone fiel, nunca
    // reinventada por la IA. Se manda al backend como extraLogoImage (uno por badge) +
    // su zona extra_logo_N marcada a mano.
    const [extraBadges, setExtraBadges] = useState<{ file: File; preview: string; name: string }[]>([]);
    const addExtraBadge = (file: File, name: string) => {
        const reader = new FileReader();
        reader.onload = ev => setExtraBadges(prev => [...prev, { file, preview: ev.target?.result as string, name }]);
        reader.readAsDataURL(file);
    };
    const removeExtraBadge = (idx: number) => setExtraBadges(prev => prev.filter((_, i) => i !== idx));
    const [isDraggingKv, setIsDraggingKv] = useState(false);
    const kvInputRef = useRef<HTMLInputElement>(null);

    // Cargar perfiles desde API al montar — con 1 reintento porque el backend puede
    // estar en cold start (dormido) justo cuando se abre la vista; sin esto, el selector
    // de "Perfiles de marca" queda vacío sin ningún indicio de error.
    React.useEffect(() => {
        const load = (timeoutMs: number): Promise<any> =>
            fetch(`${API_BASE}/api/dco/profiles`, { headers: authedHeaders(), signal: AbortSignal.timeout(timeoutMs) }).then(r => r.json());
        load(10000)
            .then(d => { if (d.profiles) setProfiles(d.profiles); })
            .catch(() => {
                // Probable cold start — reintentar una vez con más margen
                load(45000).then(d => { if (d.profiles) setProfiles(d.profiles); }).catch(() => {});
            });
    }, []);

    // Perfiles de marca
    const [profiles, setProfiles] = useState<ProfileEntry[]>([
        { id: 'generic', name: 'Genérico (desde KV)', emoji: '⬜', color: '#6b7280', type: 'builtin' },
    ]);
    const [brandProfile, setBrandProfile] = useState('generic');
    // Personajes (foto de referencia para consistencia entre generaciones)
    const [characters, setCharacters] = useState<{ id: string; name: string; referencePhotoUrl: string }[]>([]);
    const [characterId, setCharacterId] = useState<string>('');
    const [newCharacterModal, setNewCharacterModal] = useState(false);
    const [newCharacterName, setNewCharacterName] = useState('');
    const [newCharacterFile, setNewCharacterFile] = useState<File | null>(null);
    const [newCharacterPreview, setNewCharacterPreview] = useState('');
    const [savingCharacter, setSavingCharacter] = useState(false);

    React.useEffect(() => {
        const load = (timeoutMs: number): Promise<any> =>
            fetch(`${API_BASE}/api/dco/characters`, { headers: authedHeaders(), signal: AbortSignal.timeout(timeoutMs) }).then(r => r.json());
        load(10000)
            .then(d => { if (d.characters) setCharacters(d.characters); })
            .catch(() => {
                load(45000).then(d => { if (d.characters) setCharacters(d.characters); }).catch(() => {});
            });
    }, []);
    const [selectedProfileIdentity, setSelectedProfileIdentity] = useState<string | undefined>(undefined);
    const [selectedProfileQaRules, setSelectedProfileQaRules]   = useState<string[]>([]);
    const [selectedProductCategory, setSelectedProductCategory] = useState<string>('');
    const [selectedProductBenefits, setSelectedProductBenefits] = useState<string[]>([]);
    // Learn Brand modal
    const [learnStep, setLearnStep] = useState<'upload' | 'analyzing' | 'review' | 'saving' | null>(null);
    const [learnFiles, setLearnFiles]     = useState<File[]>([]);
    // Formato de cada KV subido (uno por archivo) — evita mezclar layout de formatos distintos
    const [learnFileFormats, setLearnFileFormats] = useState<string[]>([]);
    const [learnAnalysis, setLearnAnalysis] = useState<any>(null);
    const [newProfileName,  setNewProfileName]  = useState('');
    const [newProfileEmoji, setNewProfileEmoji] = useState('🏷️');
    const [newProfileColor, setNewProfileColor] = useState('#6b7280');
    const learnInputRef = useRef<HTMLInputElement>(null);

    // Manual mode
    const [manualCopy, setManualCopy] = useState({ sceneDesc: '', headline: '', subhead: '', chip: '', body: '', cta: '' });
    const [showAdvancedCopy, setShowAdvancedCopy] = useState(false);
    const [manualFormats, setManualFormats] = useState<string[]>(['feed_square', 'feed_portrait', 'story_vertical']);
    // Proveedor de imagen — Gemini es el default probado; GPT-image es opt-in para comparar.
    // GPT-image no soporta los formatos banner (excede su límite de aspect ratio 3:1 y su
    // mínimo de píxeles totales) — se filtran solos si están seleccionados al cambiar a GPT.
    const [imageProvider, setImageProvider] = useState<'gemini' | 'gpt'>('gemini');
    const updateCopy = (field: string, value: string) => { setManualCopy(prev => ({ ...prev, [field]: value })); setResults([]); setGenStatus('idle'); };
    // Beneficios como lista de bullets cortos (ej. "+Rápido +Fácil +Seguro"), no un
    // párrafo único — el KV de referencia puede traer 1, 3, o la cantidad que sea.
    const [benefits, setBenefits] = useState<string[]>(['']);
    const updateBenefit = (i: number, value: string) => { setBenefits(prev => prev.map((b, idx) => idx === i ? value : b)); setResults([]); setGenStatus('idle'); };
    const addBenefit = () => setBenefits(prev => prev.length >= 6 ? prev : [...prev, '']);
    const removeBenefit = (i: number) => {
        setBenefits(prev => prev.length <= 1 ? prev : prev.filter((_, idx) => idx !== i));
        // Las zonas "benefit_N" quedan guardadas por posicion (N = indice+1). Si se
        // borra un beneficio del medio, hay que renumerar/soltar las zonas marcadas
        // para que sigan pegadas al mismo texto que antes — si no, un beneficio
        // termina heredando la caja dibujada para OTRO beneficio ya borrado, y el
        // resultado visual es texto en una posicion que no corresponde (se ve como
        // textos superpuestos/mal ubicados).
        setManualZones(prev => {
            const next: typeof prev = {};
            for (const [key, val] of Object.entries(prev)) {
                const m = key.match(/^benefit_(\d+)$/);
                if (!m) { next[key] = val; continue; }
                const idx = parseInt(m[1], 10) - 1;
                if (idx === i) continue;
                const newIdx = idx > i ? idx - 1 : idx;
                next[`benefit_${newIdx + 1}`] = val;
            }
            return next;
        });
    };

    // Marcado manual de zonas sobre el KV — en vez de dejar que la IA adivine dónde va
    // cada elemento de copy (a veces falla la posición/tipografía exacta), el usuario
    // dibuja la caja directamente sobre la imagen de referencia y esa posición exacta
    // (en % del ancho/alto, no depende del tamaño en pantalla) se manda al backend para
    // que la respete en vez de inventar una zona propia.
    // TODO: drag-to-draw zone creation is not implemented, matching upstream. Zones are
    // only populated automatically by the "Learn brand" flow's proposedZones response,
    // or left empty (fully automatic placement by the backend). Only removal (X) exists.
    const FIXED_ZONE_LABELS: { key: FixedZoneLabel; name: string; color: string }[] = [
        { key: 'headline',          name: 'Copy principal',      color: ACCENT },
        { key: 'subhead',           name: 'Copy secundario',      color: '#2563eb' },
        { key: 'chip',              name: 'Chip/Badge',           color: '#f59e0b' },
        { key: 'cta',               name: 'CTA',                  color: '#9333ea' },
        { key: 'logo',              name: 'Logo de marca',        color: '#0891b2' },
        { key: 'brand_name',        name: 'Nombre de marca (si no subiste logo)', color: '#db2777' },
        { key: 'conglomerate_logo', name: 'Logo conglomerado',    color: '#65a30d' },
        { key: 'character',        name: 'Personaje',             color: '#ea580c' },
    ];
    const BENEFIT_ZONE_COLORS = ['#16a34a', '#0d9488', '#65a30d', '#059669', '#4d7c0f', '#0f766e'];
    const benefitZoneLabels = benefits.map((_, i) => ({
        key: `benefit_${i + 1}`, name: `Beneficio ${i + 1}`, color: BENEFIT_ZONE_COLORS[i % BENEFIT_ZONE_COLORS.length],
    }));
    const extraBadgeZoneLabels = extraBadges.map((b, i) => ({
        key: `extra_logo_${i + 1}`, name: b.name || `Badge ${i + 1}`, color: '#78716c',
    }));
    const ZONE_LABELS: { key: ZoneLabel; name: string; color: string }[] = [...FIXED_ZONE_LABELS, ...benefitZoneLabels, ...extraBadgeZoneLabels];
    const [manualZones, setManualZones] = useState<Record<string, { x: number; y: number; w: number; h: number }>>({});
    const kvImageBoxRef = useRef<HTMLDivElement>(null);

    const removeZone = (key: ZoneLabel) => setManualZones(prev => { const n = { ...prev }; delete n[key]; return n; });

    // Brief mode
    const [briefFile, setBriefFile]   = useState<File | null>(null);
    const [briefRows, setBriefRows]   = useState<BriefRow[]>([]);
    const [briefLoading, setBriefLoading] = useState(false);
    const [briefError, setBriefError] = useState('');
    const [isDraggingBrief, setIsDraggingBrief] = useState(false);
    const briefInputRef = useRef<HTMLInputElement>(null);

    // Selección de piezas + override de formato por pieza
    const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set());
    const [rowFormatOverrides, setRowFormatOverrides] = useState<Record<number, string>>({});

    // Generación
    const [genStatus, setGenStatus] = useState<GenStatus>('idle');
    const [serverMsg, setServerMsg] = useState<string>('');
    const [results, setResults]     = useState<FormatResult[]>([]);
    const [feedbackComments, setFeedbackComments] = useState<Record<string, string>>({});
    const [showCopy, setShowCopy]           = useState<Record<string, boolean>>({});
    const [showVideoPrompt, setShowVideoPrompt] = useState<Record<string, boolean>>({});
    const [showGif, setShowGif] = useState<Record<string, boolean>>({});
    const [gifLoading, setGifLoading] = useState<Record<string, boolean>>({});
    const [regenPicker, setRegenPicker]     = useState<string | null>(null);

    const doneCount = results.filter(r => r.status === 'done').length;
    const selectedCount = mode === 'brief' ? selectedRows.size : manualFormats.length;

    // ─── KV ───────────────────────────────────────────────────────────────────
    const handleKvFile = useCallback((file: File) => {
        if (!file.type.startsWith('image/')) return;
        setKvFile(file);
        const reader = new FileReader();
        reader.onload = e => setKvPreview(e.target?.result as string);
        reader.readAsDataURL(file);
        setResults([]);
        setGenStatus('idle');
    }, []);

    const onKvDrop = useCallback((e: React.DragEvent) => {
        e.preventDefault(); setIsDraggingKv(false);
        const f = e.dataTransfer.files[0]; if (f) handleKvFile(f);
    }, [handleKvFile]);

    // ─── Brief ────────────────────────────────────────────────────────────────
    const parseBrief = async (file: File) => {
        setBriefLoading(true); setBriefError(''); setBriefRows([]); setSelectedRows(new Set()); setRowFormatOverrides({});
        const fd = new FormData(); fd.append('brief', file);
        try {
            const res  = await fetch(`${API_BASE}/api/dco/parse-brief`, { method: 'POST', headers: authedHeaders(), body: fd, signal: AbortSignal.timeout(90000) });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Error al parsear');
            const pieces: BriefRow[] = data.pieces || [];
            setBriefRows(pieces);
            // Seleccionar todas por defecto
            setSelectedRows(new Set(pieces.map((r: BriefRow) => r.rowIndex)));
            if (pieces.length === 0) setBriefError('No se encontraron piezas con AUDIENCIAS y COPY válidos.');
        } catch (err: any) {
            setBriefError(err.name === 'TimeoutError' ? 'El servidor tardó demasiado (¿estaba dormido?) — intenta de nuevo.' : (err.message || 'Error al leer el archivo'));
        } finally {
            setBriefLoading(false);
        }
    };

    const handleBriefFile = useCallback((file: File) => {
        if (!file.name.match(/\.(xlsx|xls|csv)$/i)) { setBriefError('Solo .xlsx, .xls o .csv'); return; }
        setBriefFile(file); setResults([]); setGenStatus('idle');
        parseBrief(file);
    }, []);

    const onBriefDrop = useCallback((e: React.DragEvent) => {
        e.preventDefault(); setIsDraggingBrief(false);
        const f = e.dataTransfer.files[0]; if (f) handleBriefFile(f);
    }, [handleBriefFile]);

    const toggleRow = (rowIndex: number) => {
        setSelectedRows(prev => {
            const next = new Set(prev);
            next.has(rowIndex) ? next.delete(rowIndex) : next.add(rowIndex);
            return next;
        });
    };

    const toggleSelectAll = () => {
        setSelectedRows(prev =>
            prev.size === briefRows.length ? new Set() : new Set(briefRows.map(r => r.rowIndex))
        );
    };

    // ─── Export brief ─────────────────────────────────────────────────────────
    const exportBrief = async () => {
        if (!briefFile) return;
        const doneResults = results.filter(r => r.status === 'done');
        const doneIndices = doneResults
            .map(r => { const m = r.taskId.match(/^row_(\d+)/); return m ? parseInt(m[1]) : -1; })
            .filter(i => i >= 0);
        // Build video prompts map: rowIndex → prompt
        const videoPromptsMap: Record<number, string> = {};
        doneResults.forEach(r => {
            const m = r.taskId.match(/^row_(\d+)/);
            if (m && r.videoPrompt) videoPromptsMap[parseInt(m[1])] = r.videoPrompt;
        });
        const fd = new FormData();
        fd.append('brief', briefFile);
        fd.append('rows', JSON.stringify(doneIndices));
        fd.append('videoPrompts', JSON.stringify(videoPromptsMap));
        try {
            const res  = await fetch(`${API_BASE}/api/dco/export-brief`, { method: 'POST', headers: authedHeaders(), body: fd, signal: AbortSignal.timeout(30000) });
            if (!res.ok) throw new Error(`Backend respondió ${res.status}`);
            const blob = await res.blob();
            const url  = URL.createObjectURL(blob);
            const a    = document.createElement('a');
            a.href = url; a.download = 'cuadro_materiales_actualizado.xlsx'; a.click();
            URL.revokeObjectURL(url);
        } catch (err: any) {
            console.error(err);
            alert(err.name === 'TimeoutError' ? 'El servidor tardó demasiado — intenta de nuevo.' : `No se pudo exportar: ${err.message || 'error de conexión'}`);
        }
    };

    // ─── Motor de Copys IA ──────────────────────────────────────────────────────
    const generateCopies = async () => {
        if (!copyBriefFile || copyLoading) return;
        setCopyLoading(true); setCopyError(''); setCopyIdentity(null); setCopyPieces([]);
        const fd = new FormData();
        fd.append('brief', copyBriefFile);
        fd.append('variantsPerAudience', String(variantsPerAudience));
        fd.append('newAudiences', String(newAudiencesCount));
        if (copyInstructions.trim()) fd.append('instructions', copyInstructions.trim());
        // El KV ya subido en "1 · KV de referencia" — para que el copy generado encaje
        // con lo que efectivamente se ve en la imagen, no sea genérico.
        if (kvFile) fd.append('kvImage', kvFile);
        // Si ya marcaste zonas a mano, mandarlas + el tamaño real del formato de referencia
        // para que el copy generado venga con la longitud que efectivamente entra en cada
        // zona (no un límite de palabras genérico, el real de la caja que dibujaste).
        if (Object.keys(manualZones).length > 0) {
            fd.append('manualZones', JSON.stringify(manualZones));
            const refFmt = FORMATS.find(f => f.id === manualFormats[0]) || FORMATS[0];
            const [refW, refH] = refFmt.dims.split('×').map(s => parseInt(s.replace(/\D/g, '')));
            fd.append('refWidth', String(refW));
            fd.append('refHeight', String(refH));
        }
        try {
            const res  = await fetch(`${API_BASE}/api/dco/generate-copies`, { method: 'POST', headers: authedHeaders(), body: fd, signal: AbortSignal.timeout(90000) });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Error generando copys');
            setCopyIdentity(data.identity || null);
            setCopyPieces(data.pieces || []);
            if (!(data.pieces || []).length) setCopyError('No se generaron copys con este cuadro.');
        } catch (e: any) { setCopyError(e.name === 'TimeoutError' ? 'El servidor tardó demasiado — intenta de nuevo.' : (e.message || 'Error al generar copys')); }
        finally { setCopyLoading(false); }
    };

    // Genera copys directo desde audiencias tipeadas en el form (sin Excel) — reutiliza
    // la identidad de copy ya guardada del perfil de marca, o la deriva de su análisis
    // visual si nunca se generó una antes.
    const generateCopiesFromAudiences = async () => {
        const filled = audienceList.filter(a => a.name.trim() || a.ageRange.trim() || a.interests.trim());
        if (!filled.length || copyLoading) return;
        setCopyLoading(true); setCopyError(''); setCopyIdentity(null); setCopyPieces([]);
        // El KV ya subido en "1 · KV de referencia" — mismo motivo que en generateCopies:
        // que el copy generado encaje con la imagen real, no sea genérico. kvPreview ya
        // es un data URL ("data:image/xxx;base64,...."), lo partimos para mandarlo suelto.
        const kvMatch = kvPreview.match(/^data:(.+);base64,(.+)$/);
        // Mismo criterio que en generateCopies: si hay zonas marcadas, mandar sus
        // dimensiones reales para que el copy venga con la longitud que entra ahí.
        const hasZones = Object.keys(manualZones).length > 0;
        const refFmt = FORMATS.find(f => f.id === manualFormats[0]) || FORMATS[0];
        const [refW, refH] = refFmt.dims.split('×').map(s => parseInt(s.replace(/\D/g, '')));
        try {
            const res = await fetch(`${API_BASE}/api/dco/generate-copies-from-audiences`, {
                method: 'POST',
                headers: authedHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({
                    profileId: brandProfile,
                    audiences: filled,
                    variantsPerAudience,
                    instructions: copyInstructions.trim() || undefined,
                    kvImageMime: kvMatch ? kvMatch[1] : undefined,
                    kvImageBase64: kvMatch ? kvMatch[2] : undefined,
                    manualZones: hasZones ? manualZones : undefined,
                    refWidth: hasZones ? refW : undefined,
                    refHeight: hasZones ? refH : undefined,
                }),
                signal: AbortSignal.timeout(90000),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Error generando copys');
            setCopyIdentity(data.identity || null);
            setCopyPieces(data.pieces || []);
            if (!(data.pieces || []).length) setCopyError('No se generaron copys con estas audiencias.');
        } catch (e: any) { setCopyError(e.name === 'TimeoutError' ? 'El servidor tardó demasiado — intenta de nuevo.' : (e.message || 'Error al generar copys')); }
        finally { setCopyLoading(false); }
    };

    // Sugiere audiencias automáticamente leyendo SOLO el KV (sin tipear nada a mano) —
    // pisa audienceList con lo que devuelve /suggest-audiences; el usuario las revisa/edita
    // igual que si las hubiera tipeado él, y sigue el flujo normal (generar copies → enviar a DCO).
    const suggestAudiences = async () => {
        if (!kvFile || suggestingAudiences) return;
        setSuggestingAudiences(true); setCopyError('');
        const fd = new FormData();
        fd.append('kvImage', kvFile);
        fd.append('count', '3');
        if (selectedProductCategory) fd.append('productCategory', selectedProductCategory);
        try {
            const res = await fetch(`${API_BASE}/api/dco/suggest-audiences`, { method: 'POST', headers: authedHeaders(), body: fd, signal: AbortSignal.timeout(60000) });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Error sugiriendo audiencias');
            if (Array.isArray(data.audiences) && data.audiences.length) {
                setAudienceList(data.audiences.map((a: any) => ({
                    name: a.name || '', ageRange: a.ageRange || '', interests: a.interests || '',
                    wardrobe: a.wardrobe || '', headwear: a.headwear || '', environment: a.environment || '',
                })));
            }
        } catch (e: any) { setCopyError(e.name === 'TimeoutError' ? 'El servidor tardó demasiado — intenta de nuevo.' : (e.message || 'Error al sugerir audiencias')); }
        finally { setSuggestingAudiences(false); }
    };

    // ── Modo "Automático" — un solo botón: sube el KV, se leen audiencias (con perfil
    // visual) y se genera su copy encadenado, sin que el usuario escriba ni tipee nada.
    // Reutiliza los mismos dos endpoints que ya usa el flujo manual de audiencias.
    const [autoAudienceCount, setAutoAudienceCount] = useState(3);
    const [autoGenerating, setAutoGenerating] = useState(false);
    // Contexto de negocio libre y opcional — para que la IA no dependa solo de lo que
    // interpreta de la imagen (útil sobre todo con marcas menos conocidas o KVs ambiguos).
    const [autoBusinessContext, setAutoBusinessContext] = useState('');
    const generateAutomatic = async () => {
        if (!kvFile || autoGenerating) return;
        setAutoGenerating(true); setCopyError(''); setCopyIdentity(null); setCopyPieces([]);
        try {
            const fd = new FormData();
            fd.append('kvImage', kvFile);
            fd.append('count', String(autoAudienceCount));
            if (selectedProductCategory) fd.append('productCategory', selectedProductCategory);
            if (autoBusinessContext.trim()) fd.append('businessContext', autoBusinessContext.trim());
            const res1 = await fetch(`${API_BASE}/api/dco/suggest-audiences`, { method: 'POST', headers: authedHeaders(), body: fd, signal: AbortSignal.timeout(60000) });
            const data1 = await res1.json();
            if (!res1.ok) throw new Error(data1.error || 'Error sugiriendo audiencias');
            const audiences = (Array.isArray(data1.audiences) ? data1.audiences : []).map((a: any) => ({
                name: a.name || '', ageRange: a.ageRange || '', interests: a.interests || '',
                wardrobe: a.wardrobe || '', headwear: a.headwear || '', environment: a.environment || '',
            }));
            if (!audiences.length) throw new Error('No se generaron audiencias');
            setAudienceList(audiences);

            const kvMatch = kvPreview.match(/^data:(.+);base64,(.+)$/);
            const res2 = await fetch(`${API_BASE}/api/dco/generate-copies-from-audiences`, {
                method: 'POST',
                headers: authedHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({
                    profileId: brandProfile,
                    audiences,
                    variantsPerAudience: 1,
                    instructions: autoBusinessContext.trim() || undefined,
                    kvImageMime: kvMatch ? kvMatch[1] : undefined,
                    kvImageBase64: kvMatch ? kvMatch[2] : undefined,
                }),
                signal: AbortSignal.timeout(90000),
            });
            const data2 = await res2.json();
            if (!res2.ok) throw new Error(data2.error || 'Error generando copies');
            setCopyIdentity(data2.identity || null);
            setCopyPieces(data2.pieces || []);
            if (!(data2.pieces || []).length) setCopyError('No se generaron copys para estas audiencias.');
        } catch (e: any) {
            setCopyError(e.name === 'TimeoutError' ? 'El servidor tardó demasiado — intenta de nuevo.' : (e.message || 'Error en la generación automática'));
        } finally {
            setAutoGenerating(false);
        }
    };

    const downloadCuadro = async () => {
        if (!copyPieces.length) return;
        try {
            const res = await fetch(`${API_BASE}/api/dco/export-cuadro`, {
                method: 'POST', headers: authedHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ pieces: copyPieces, meta: { marca: copyIdentity?.marca || 'MARCA' } }),
                signal: AbortSignal.timeout(30000),
            });
            if (!res.ok) throw new Error(`Backend respondió ${res.status}`);
            const blob = await res.blob();
            const url  = URL.createObjectURL(blob);
            const a    = document.createElement('a');
            a.href = url; a.download = 'cuadro_materiales_generado.xlsx'; a.click();
            URL.revokeObjectURL(url);
        } catch (e: any) {
            console.error(e);
            alert(e.name === 'TimeoutError' ? 'El servidor tardó demasiado — intenta de nuevo.' : `No se pudo exportar: ${e.message || 'error de conexión'}`);
        }
    };

    const updateCopyPiece = (idx: number, field: string, value: string | boolean) => {
        setCopyPieces(prev => prev.map((p, i) => {
            if (i !== idx) return p;
            const next: any = { ...p, [field]: value };
            // Mantener el bloque COPY sincronizado si editan los sub-campos
            if (['copy_principal', 'desarrollo', 'cierre'].includes(field)) {
                const cp = field === 'copy_principal' ? value : (p.copy_principal ?? '');
                const de = field === 'desarrollo'     ? value : (p.desarrollo ?? '');
                const ci = field === 'cierre'         ? value : (p.cierre ?? '');
                next.copyFull = [cp && `COPY PRINCIPAL: ${cp}`, de && `DESARROLLO: ${de}`, ci && `CIERRE: ${ci}`].filter(Boolean).join('\n');
            }
            return next;
        }));
    };

    // Envía los copys generados al modo Brief para producir las imágenes en el DCO
    const sendCopiesToDCO = () => {
        if (!copyPieces.length) return;
        const rows = copyPieces.map((p, i) => ({
            rowIndex:      i,
            audience:      p.audiencia || '',
            audienciaRef:  p.audienciaRef || '',
            drivers:       p.drivers || '',
            tono:          p.tono || '',
            variante:      p.variante || '',
            observaciones: p.observaciones || '',
            copyPreview:   p.copyPreview || (p.copyFull || '').slice(0, 200),
            copyFull:      p.copyFull || '',
            dimensions:    p.tamano || '1080x1080',
            formatId:      p.formatId || 'feed_square',
            formatLabel:   p.formato || '',
            platform:      p.platform || '',
            campaña:       p.campana || '',
            medio:         p.medio || '',
            formato:       p.formato || '',
            characterId:   p.characterId || undefined,
            beneficios:    Array.isArray(p.beneficios) ? p.beneficios : [],
            wardrobe:      p.wardrobe || '',
            headwear:      p.headwear || '',
            environment:   p.environment || '',
            varyScene:     !!p.varyScene,
        }));
        setBriefRows(rows as any);
        setSelectedRows(new Set(rows.map(r => r.rowIndex)));
        setRowFormatOverrides({});
        if (copyBriefFile) setBriefFile(copyBriefFile);
        setMode('brief');
        setResults([]); setGenStatus('idle');
    };

    // Parsea el bloque de texto plano "COPY PRINCIPAL: ...\nDESARROLLO: ...\nCIERRE: ..."
    // (formato que ya usa copyFull en todo el resto del archivo) en campos sueltos —
    // necesario para alimentar /recreate-formats, que espera { headline, subhead, cta }.
    const parseCopyFullToFields = (copyFull: string) => ({
        headline: copyFull.match(/COPY PRINCIPAL:\s*(.+)/i)?.[1]?.trim() || '',
        subhead:  copyFull.match(/DESARROLLO:\s*(.+)/i)?.[1]?.trim() || '',
        cta:      copyFull.match(/CIERRE:\s*(.+)/i)?.[1]?.trim() || '',
    });

    // Corre `worker` sobre `items` con un máximo de `limit` en simultáneo — mismo criterio
    // de concurrencia acotada que ya usa el backend para no saturar la API del proveedor de IA.
    async function runWithConcurrency<T>(items: T[], limit: number, worker: (item: T) => Promise<void>) {
        let idx = 0;
        const next = async (): Promise<void> => {
            const i = idx++;
            if (i >= items.length) return;
            await worker(items[i]);
            return next();
        };
        await Promise.all(Array.from({ length: Math.min(limit, items.length) }, next));
    }

    // Recrea UNA fila del brief con el motor nuevo (outpainting del KV real) — misma
    // lógica que recreateWithAI (botón individual del Motor de Copys IA), pero alimentada
    // desde una fila de brief (Excel o audiencias automáticas) en vez de un copyPiece.
    const recreateRowWithAI = async (row: BriefRow & { formatId: string }) => {
        const taskId = `row_${row.rowIndex}${row.variante ? `_v${row.variante}` : ''}`;
        setResults(prev => prev.map(r => r.taskId === taskId ? { ...r, status: 'generating' } : r));
        const { headline, subhead, cta } = parseCopyFullToFields(row.copyFull || '');
        const copyPayload: RecreateCopy = { headline, subhead, beneficios: row.beneficios || [], cta };
        try {
            const result = await recreateOneFormat(row.formatId, copyPayload, (row as any).wardrobe || '', (row as any).headwear || '', (row as any).environment || '', !!row.varyScene);
            setResults(prev => prev.map(r => r.taskId === taskId ? { ...r, status: 'done', imageBase64: result.imageBase64, mimeType: result.mimeType } : r));
        } catch (e: any) {
            setResults(prev => prev.map(r => r.taskId === taskId ? { ...r, status: 'error', error: e.message || 'Error de conexión' } : r));
        }
    };

    // Corre las filas que SÍ soporta el motor nuevo (todo salvo banners) — en paralelo
    // acotado; cada una llama a /recreate-formats individualmente porque cada fila tiene
    // su propio copy/audiencia (a diferencia del botón individual, que comparte un solo
    // copy entre varios formatos de UNA pieza).
    const runRecreateBriefRows = async (rows: (BriefRow & { formatId: string })[]) => {
        await runWithConcurrency(rows, 2, recreateRowWithAI);
    };

    // Corre las filas que el motor nuevo NO soporta (formatos banner — límite de tamaño/
    // aspect ratio de GPT-image) con el motor viejo (/generate, escena nueva + texto por
    // código) — único caso donde ese motor sigue siendo necesario.
    const runLegacyBriefRows = async (rows: (BriefRow & { formatId: string })[]) => {
        if (!rows.length) return;
        const fd = new FormData();
        fd.append('kvImage', kvFile!);
        fd.append('brandProfile', brandProfile);
        if (characterId) fd.append('characterId', characterId);
        productFiles.forEach(f => fd.append('productImage', f));
        if (logoFile) fd.append('logoImage', logoFile);
        if (conglomerateLogoFile) fd.append('conglomerateLogoImage', conglomerateLogoFile);
        extraBadges.forEach(b => fd.append('extraLogoImage', b.file));
        fd.append('imageProvider', imageProvider);
        fd.append('tasks', JSON.stringify(rows.map(r => ({
            rowIndex:      r.rowIndex,
            audience:      r.audience,
            audienciaRef:  r.audienciaRef  || '',
            drivers:       r.drivers       || '',
            tono:          r.tono          || '',
            variante:      r.variante      || '',
            observaciones: r.observaciones || '',
            copyFull:      r.copyFull,
            formatId:      r.formatId,
            characterId:   r.characterId || undefined,
            beneficios:    r.beneficios || [],
        }))));
        if (Object.keys(manualZones).length > 0) fd.append('manualZones', JSON.stringify(manualZones));
        if (selectedProfileIdentity) fd.append('customIdentityBlock', selectedProfileIdentity);
        if (selectedProfileQaRules.length > 0) fd.append('customQaRules', JSON.stringify(selectedProfileQaRules));
        if (selectedProductCategory) fd.append('productCategory', selectedProductCategory);
        if (selectedProductBenefits.length > 0) fd.append('productBenefits', JSON.stringify(selectedProductBenefits));

        const res = await fetchWithColdStartRetry(`${API_BASE}/api/dco/generate`, { method: 'POST', headers: authedHeaders(), body: fd });
        if (!res.ok || !res.body) {
            const errDetail = await extractErrorDetail(res);
            rows.forEach(r => {
                const taskId = `row_${r.rowIndex}${r.variante ? `_v${r.variante}` : ''}`;
                setResults(prev => prev.map(x => x.taskId === taskId ? { ...x, status: 'error', error: errDetail } : x));
            });
            return;
        }
        await consumeSSE(res, ev => {
            if (ev.type === 'start')  setResults(prev => prev.map(r => r.taskId === ev.taskId ? { ...r, status: 'generating', sceneDesc: ev.sceneDesc, copyData: ev.copy } : r));
            if (ev.type === 'qa_retry') setResults(prev => prev.map(r => r.taskId === ev.taskId ? { ...r, status: 'qa_check' } : r));
            if (ev.type === 'qa_score') setResults(prev => prev.map(r => r.taskId === ev.taskId ? { ...r, qaResult: { score: ev.score, passed: ev.passed, issues: ev.errors || [] } } : r));
            if (ev.type === 'result') setResults(prev => prev.map(r => r.taskId === ev.taskId ? { ...r, status: 'done', imageBase64: ev.imageBase64, mimeType: ev.mimeType, width: ev.width, height: ev.height, qaAttempts: ev.qaAttempts, videoPrompt: ev.videoPrompt, gifBase64: ev.gifBase64 } : r));
            if (ev.type === 'error') setResults(prev => prev.map(r => r.taskId === ev.taskId ? { ...r, status: 'error', error: ev.error } : r));
        });
    };

    // ─── Generación ───────────────────────────────────────────────────────────
    const generate = async () => {
        if (mode === 'copys' || mode === 'auto') return;
        if (!kvFile || genStatus === 'generating') return;
        if (mode === 'brief' && selectedRows.size === 0) return;
        if (mode === 'manual' && manualFormats.length === 0) return;

        setGenStatus('generating');

        // Modo Brief (Excel o audiencias automáticas) — parte a la foto REAL del KV vía
        // /recreate-formats para TODOS los formatos; el backend elige el proveedor
        // (GPT-image o Gemini de respaldo para banners) según el formato pedido.
        if (mode === 'brief') {
            const activeBriefRows = briefRows
                .filter(r => selectedRows.has(r.rowIndex))
                .map(r => ({ ...r, formatId: rowFormatOverrides[r.rowIndex] || r.formatId }));

            const fmtLabel = (fmtId: string) => {
                const f = FORMATS.find(x => x.id === fmtId);
                return f ? `${f.label} · ${f.dims}` : fmtId;
            };

            const initial: FormatResult[] = activeBriefRows.map(r => ({
                taskId: `row_${r.rowIndex}${r.variante ? `_v${r.variante}` : ''}`,
                format: r.formatId,
                label: `${r.audience || '—'}${r.variante ? ` · v${r.variante}` : ''} · ${fmtLabel(r.formatId)}`,
                audience: r.audience,
                copyPreview: r.copyPreview,
                platform: FORMATS.find(f => f.id === r.formatId)?.platform || '',
                width: 0, height: 0, imageBase64: '', mimeType: '',
                status: 'waiting' as const,
            }));
            setResults(initial);

            const recreateRows = activeBriefRows.filter(r => RECREATE_FORMAT_OPTIONS.includes(r.formatId));
            const legacyRows    = activeBriefRows.filter(r => !RECREATE_FORMAT_OPTIONS.includes(r.formatId));

            try {
                await Promise.all([runRecreateBriefRows(recreateRows), runLegacyBriefRows(legacyRows)]);
            } finally {
                setGenStatus('done');
            }
            return;
        }

        const fd = new FormData();
        fd.append('kvImage', kvFile);
        fd.append('brandProfile', brandProfile);
        if (characterId) fd.append('characterId', characterId);
        productFiles.forEach(f => fd.append('productImage', f));
        if (logoFile) fd.append('logoImage', logoFile);
        if (conglomerateLogoFile) fd.append('conglomerateLogoImage', conglomerateLogoFile);
        extraBadges.forEach(b => fd.append('extraLogoImage', b.file));
        fd.append('imageProvider', imageProvider);

        const initial: FormatResult[] = manualFormats.map(fmtId => {
            const fmt = FORMATS.find(f => f.id === fmtId)!;
            return {
                taskId: fmtId, format: fmtId,
                label: `${fmt.label} · ${fmt.dims}`,
                platform: fmt.platform,
                sceneDesc: manualCopy.sceneDesc,
                copyData: { headline: manualCopy.headline, subhead: manualCopy.subhead, chip: manualCopy.chip, body: benefits.filter(Boolean).join(' · '), cta: manualCopy.cta, beneficios: benefits.filter(Boolean) },
                width: 0, height: 0, imageBase64: '', mimeType: '',
                status: 'waiting' as const,
            };
        });
        fd.append('sceneDesc', manualCopy.sceneDesc);
        fd.append('headline',  manualCopy.headline);
        fd.append('subhead',   manualCopy.subhead);
        fd.append('chip',      manualCopy.chip);
        fd.append('body',      benefits.filter(Boolean).join(' · '));
        fd.append('beneficios', JSON.stringify(benefits.filter(Boolean)));
        fd.append('cta',       manualCopy.cta);
        fd.append('formats',   manualFormats.join(','));
        if (Object.keys(manualZones).length > 0) fd.append('manualZones', JSON.stringify(manualZones));
        if (selectedProfileIdentity) fd.append('customIdentityBlock', selectedProfileIdentity);
        if (selectedProfileQaRules.length > 0) fd.append('customQaRules', JSON.stringify(selectedProfileQaRules));
        if (selectedProductCategory) fd.append('productCategory', selectedProductCategory);
        if (selectedProductBenefits.length > 0) fd.append('productBenefits', JSON.stringify(selectedProductBenefits));

        setResults(initial);

        try {
            setServerMsg('Conectando...');
            let res = await fetch(`${API_BASE}/api/dco/generate`, { method: 'POST', headers: authedHeaders(), body: fd });
            if (res.status === 502 || res.status === 503) {
                setServerMsg('⏳ Servidor despertando — espera ~60s...');
                await new Promise(r => setTimeout(r, 8000));
                res = await fetch(`${API_BASE}/api/dco/generate`, { method: 'POST', headers: authedHeaders(), body: fd });
            }
            if (!res.ok || !res.body) throw new Error(await extractErrorDetail(res));
            setServerMsg('');

            await consumeSSE(res, ev => {
                if (ev.type === 'start')     setResults(prev => prev.map(r => r.taskId === ev.taskId ? { ...r, status: 'generating', sceneDesc: ev.sceneDesc, copyData: ev.copy } : r));
                if (ev.type === 'qa_retry')          setResults(prev => prev.map(r => r.taskId === ev.taskId ? { ...r, status: 'qa_check' } : r));
                if (ev.type === 'qa_score')          setResults(prev => prev.map(r => r.taskId === ev.taskId ? { ...r, qaResult: { score: ev.score, passed: ev.passed, issues: ev.errors || [] } } : r));
                if (ev.type === 'result')              setResults(prev => prev.map(r => r.taskId === ev.taskId ? { ...r, status: 'done', imageBase64: ev.imageBase64, mimeType: ev.mimeType, width: ev.width, height: ev.height, qaAttempts: ev.qaAttempts, videoPrompt: ev.videoPrompt, gifBase64: ev.gifBase64 } : r));
                if (ev.type === 'error')               setResults(prev => prev.map(r => r.taskId === ev.taskId ? { ...r, status: 'error', error: ev.error } : r));
                if (ev.type === 'done')                setGenStatus('done');
            });
            // Stream closed sin evento 'done' — limpiar tarjetas atascadas
            setGenStatus(prev => prev === 'generating' ? 'done' : prev);
            setResults(prev => prev.map(r => ['waiting', 'generating', 'qa_check'].includes(r.status) ? { ...r, status: 'error', error: 'Conexión cortada — reintenta' } : r));
        } catch (err: any) {
            setServerMsg('');
            setGenStatus('error');
            setResults(prev => prev.map(r => ({ ...r, status: 'error', error: err.message })));
        }
    };

    const generateCarousel = async () => {
        if (!kvFile || !carouselNarrative.trim()) return;
        setCarouselStatus('generating');
        setCarouselBeats([]);
        setCarouselSlides({});
        setCarouselError('');

        const fd = new FormData();
        fd.append('kvImage', kvFile);
        fd.append('brandProfile', brandProfile);
        if (characterId) fd.append('characterId', characterId);
        fd.append('narrative', carouselNarrative.trim());
        fd.append('format', carouselFormat);
        fd.append('slideCount', String(carouselSlideCount));
        if (logoFile) fd.append('logoImage', logoFile);

        try {
            const res = await fetch(`${API_BASE}/api/dco/generate-carousel`, { method: 'POST', headers: authedHeaders(), body: fd });
            if (!res.ok || !res.body) throw new Error('Error al iniciar el carrusel');
            await consumeSSE(res, ev => {
                if (ev.type === 'story_start') setCarouselBeats(ev.beats);
                if (ev.type === 'slide_start') setCarouselSlides(prev => ({ ...prev, [ev.index]: { imageBase64: '', mimeType: '', score: 0, status: 'generating' } }));
                if (ev.type === 'slide_done') setCarouselSlides(prev => ({ ...prev, [ev.index]: { imageBase64: ev.imageBase64, mimeType: ev.mimeType, score: ev.score, status: 'done' } }));
                if (ev.type === 'slide_error') setCarouselSlides(prev => ({ ...prev, [ev.index]: { imageBase64: '', mimeType: '', score: 0, status: 'error' } }));
                if (ev.type === 'done') setCarouselStatus('done');
                if (ev.type === 'error') { setCarouselStatus('error'); setCarouselError(ev.error || 'Error'); }
            });
            setCarouselStatus(prev => prev === 'generating' ? 'done' : prev);
        } catch (err: any) {
            setCarouselStatus('error');
            setCarouselError(err.message || 'Error de conexión');
        }
    };

    const downloadImage = (item: FormatResult) => {
        const ext  = item.mimeType.includes('png') ? 'png' : 'jpg';
        const dims = item.width && item.height ? `_${item.width}x${item.height}` : '';
        const name = mode === 'brief'
            ? `DCO_${(item.audience || 'brief').replace(/[\s/]+/g, '_')}_${item.format}${dims}`
            : `DCO_manual_${item.format}${dims}`;
        const a = document.createElement('a');
        a.href = `data:${item.mimeType};base64,${item.imageBase64}`;
        a.download = `${name}.${ext}`;
        a.click();
    };

    const downloadAll = () => results.filter(r => r.status === 'done').forEach(downloadImage);

    const sendFeedback = async (item: FormatResult, rating: 'good' | 'bad', comment = '') => {
        setResults(prev => prev.map(r => r.taskId === item.taskId ? { ...r, feedback: rating, feedbackComment: comment } : r));
        try {
            // Email del usuario logueado provisto por el host — sin leer localStorage directamente.
            const userEmail = currentUserEmail || '';
            await fetch(`${API_BASE}/api/dco/feedback`, {
                method: 'POST',
                headers: authedHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({
                    profileId: brandProfile, formatId: item.format,
                    audience: item.audience || '', headline: item.label,
                    rating, comment, userEmail,
                }),
            });
            setResults(prev => prev.map(r => r.taskId === item.taskId ? { ...r, feedbackSent: true } : r));
        } catch { /* silent */ }
    };

    const retouchItem = async (item: FormatResult, correction: string) => {
        if (!kvFile || !item.imageBase64) return;
        setResults(prev => prev.map(r => r.taskId === item.taskId ? { ...r, status: 'generating', feedback: null } : r));
        try {
            const fd = new FormData();
            fd.append('kvImage',             kvFile);
            fd.append('originalImageBase64', item.imageBase64);
            fd.append('originalMime',        item.mimeType || 'image/jpeg');
            fd.append('correction',          correction);
            fd.append('formatId',            item.format);
            fd.append('profileId',           brandProfile);
            const res  = await fetch(API_BASE + '/api/dco/retouch', { method: 'POST', headers: authedHeaders(), body: fd, signal: AbortSignal.timeout(90000) });
            const data = await res.json();
            if (!res.ok || data.error) throw new Error(data.error || 'Error en retouch');
            setResults(prev => prev.map(r => r.taskId === item.taskId ? {
                ...r, imageBase64: data.imageBase64, mimeType: data.mimeType,
                status: 'done', feedback: null, feedbackSent: false,
            } : r));
        } catch (err: any) {
            setResults(prev => prev.map(r => r.taskId === item.taskId ? { ...r, status: 'done' } : r));
            alert(err.name === 'TimeoutError' ? 'El servidor tardó demasiado — intenta de nuevo.' : ('Error al retocar: ' + err.message));
        }
    };

    const regenerateInFormat = useCallback(async (item: FormatResult, newFormatId: string) => {
        if (!kvFile || !item.sceneDesc || !item.copyData) return;
        const newTaskId = `regen_${newFormatId}_${Date.now()}`;
        const fmt = FORMATS.find(f => f.id === newFormatId);
        if (!fmt) return;
        setResults(prev => [...prev, {
            taskId: newTaskId, format: newFormatId,
            label: `${fmt.label} · ${fmt.dims}`,
            platform: fmt.platform,
            audience: item.audience,
            copyPreview: item.copyPreview,
            sceneDesc: item.sceneDesc,
            copyData: item.copyData,
            width: 0, height: 0, imageBase64: '', mimeType: '',
            status: 'waiting' as const,
        }]);
        setRegenPicker(null);
        const fd = new FormData();
        fd.append('kvImage', kvFile);
        fd.append('brandProfile', brandProfile);
        if (characterId) fd.append('characterId', characterId);
        productFiles.forEach(f => fd.append('productImage', f));
        if (logoFile) fd.append('logoImage', logoFile);
        if (conglomerateLogoFile) fd.append('conglomerateLogoImage', conglomerateLogoFile);
        extraBadges.forEach(b => fd.append('extraLogoImage', b.file));
        fd.append('imageProvider', imageProvider);
        fd.append('tasks', JSON.stringify([{
            taskId: newTaskId, formatId: newFormatId,
            explicitSceneDesc: item.sceneDesc, explicitCopy: item.copyData,
        }]));
        try {
            const res = await fetch(`${API_BASE}/api/dco/generate`, { method: 'POST', headers: authedHeaders(), body: fd });
            if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
            await consumeSSE(res, ev => {
                if (ev.type === 'start')    setResults(prev => prev.map(r => r.taskId === ev.taskId ? { ...r, status: 'generating' } : r));
                if (ev.type === 'qa_retry')          setResults(prev => prev.map(r => r.taskId === ev.taskId ? { ...r, status: 'qa_check' } : r));
                if (ev.type === 'qa_score')          setResults(prev => prev.map(r => r.taskId === ev.taskId ? { ...r, qaResult: { score: ev.score, passed: ev.passed, issues: ev.errors || [] } } : r));
                if (ev.type === 'result')            setResults(prev => prev.map(r => r.taskId === ev.taskId ? { ...r, status: 'done', imageBase64: ev.imageBase64, mimeType: ev.mimeType, width: ev.width, height: ev.height, qaAttempts: ev.qaAttempts } : r));
                if (ev.type === 'error')             setResults(prev => prev.map(r => r.taskId === ev.taskId ? { ...r, status: 'error', error: ev.error } : r));
            });
        } catch (err: any) {
            setResults(prev => prev.map(r => r.taskId === newTaskId ? { ...r, status: 'error', error: err.message } : r));
        }
    }, [kvFile, brandProfile]);

    const canGenerate = kvFile && genStatus !== 'generating' && selectedCount > 0 && (mode === 'brief' || manualCopy.headline.trim().length > 0);

    // ─── Render ───────────────────────────────────────────────────────────────
    return (
        <div style={{ height: '100%', minHeight: 0, background: 'var(--z-bg)', color: 'var(--z-text)', fontFamily: 'inherit', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

            {/* ── Header ──────────────────────────────────────────────────── */}
            <div style={{ borderBottom: '1px solid var(--z-border)', padding: '0.875rem 1.5rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'var(--z-surface)', flexShrink: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                    <div style={{ width: 34, height: 34, borderRadius: 9, background: `linear-gradient(135deg, ${ACCENT}, ${ACCENT_LIGHT})`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <Sparkles size={17} color="#fff" />
                    </div>
                    <div>
                        <div style={{ fontWeight: 800, fontSize: '1rem', letterSpacing: '0.04em', textTransform: 'uppercase' }}>DCO Studio</div>
                        <div style={{ fontSize: '0.68rem', color: 'var(--z-text-muted)', letterSpacing: '0.05em' }}>Generador de creatividades · IA</div>
                    </div>
                </div>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                    {doneCount > 0 && mode === 'brief' && genStatus === 'done' && (
                        <button onClick={exportBrief} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', padding: '0.5rem 1rem', background: '#16a34a', color: '#fff', border: 'none', borderRadius: 7, fontSize: '0.75rem', fontWeight: 700, cursor: 'pointer', letterSpacing: '0.04em', textTransform: 'uppercase' }}>
                            <FileText size={13} /> Exportar Brief
                        </button>
                    )}
                    {doneCount > 0 && (
                        <button onClick={downloadAll} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', padding: '0.5rem 1rem', background: ACCENT, color: '#fff', border: 'none', borderRadius: 7, fontSize: '0.75rem', fontWeight: 700, cursor: 'pointer', letterSpacing: '0.04em', textTransform: 'uppercase' }}>
                            <Download size={13} /> Descargar todo ({doneCount})
                        </button>
                    )}
                </div>
            </div>

            {/* ── Cuerpo principal ────────────────────────────────────────── */}
            <div className="grid grid-cols-1 md:grid-cols-[380px_1fr]" style={{ flex: 1, minHeight: 0 }}>

                {/* ── Panel izquierdo ─────────────────────────────────────── */}
                <div style={{ borderRight: '1px solid var(--z-border)', display: 'flex', flexDirection: 'column', background: 'var(--z-surface)', overflow: 'hidden' }}>

                    {/* ── Botón generar (sticky arriba, siempre visible) ─── */}
                    {serverMsg && <div style={{ padding: '0.5rem 1.25rem', background: 'rgba(245,158,11,0.15)', borderBottom: '1px solid rgba(245,158,11,0.4)', fontSize: '0.72rem', color: '#f59e0b', fontWeight: 600 }}>⏳ {serverMsg}</div>}
                    {mode !== 'copys' && mode !== 'auto' && (
                    <div style={{ padding: '0.85rem 1.25rem', borderBottom: '1px solid var(--z-border)', background: 'var(--z-surface)', flexShrink: 0 }}>
                        <button
                            onClick={generate}
                            disabled={!canGenerate}
                            style={{
                                width: '100%', padding: '0.85rem', borderRadius: 10, border: 'none',
                                background: !canGenerate ? 'var(--z-border)' : `linear-gradient(135deg, ${ACCENT}, ${ACCENT_DARK})`,
                                color: !canGenerate ? 'var(--z-text-muted)' : '#fff',
                                fontWeight: 800, fontSize: '0.88rem', letterSpacing: '0.06em', textTransform: 'uppercase',
                                cursor: !canGenerate ? 'not-allowed' : 'pointer',
                                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.6rem',
                                transition: 'all 0.2s',
                                boxShadow: canGenerate ? `0 4px 16px ${accentA(0.35)}` : 'none',
                            }}>
                            {genStatus === 'generating'
                                ? <><Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} /> Generando {doneCount}/{results.length}...</>
                                : !kvFile
                                    ? '← Sube el KV primero'
                                    : selectedCount === 0
                                        ? 'Selecciona al menos 1 pieza'
                                        : <><Sparkles size={16} /> Generar {selectedCount} pieza{selectedCount !== 1 ? 's' : ''}</>
                            }
                        </button>
                    </div>
                    )}

                    {selectedCount > 15 && genStatus !== 'generating' && (
                        <div style={{ padding: '0.45rem 1.25rem', background: 'rgba(245,158,11,0.12)', borderBottom: '1px solid rgba(245,158,11,0.3)', fontSize: '0.68rem', color: '#f59e0b', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                            ⚠️ Recomendado máx. 15 piezas por sesión. Con {selectedCount} puede haber timeout en backends de free tier.
                        </div>
                    )}
                    {/* Scroll area */}
                    <div style={{ flex: 1, overflowY: 'auto', padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>

                        {/* ── 1. KV de referencia ───────────────────────── */}
                        <div>
                            <div style={{ fontSize: '0.65rem', fontWeight: 800, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--z-text-muted)', marginBottom: '0.6rem' }}>
                                1 · KV de referencia
                            </div>
                            {kvPreview ? (
                                <div style={{ position: 'relative', borderRadius: 10, overflow: 'hidden', border: '2px solid var(--z-border)' }}>
                                    <img src={kvPreview} alt="KV" style={{ width: '100%', display: 'block', maxHeight: 200, objectFit: 'cover' }} />
                                    <button onClick={() => { setKvFile(null); setKvPreview(''); setResults([]); setGenStatus('idle'); }}
                                        style={{ position: 'absolute', top: 8, right: 8, background: 'rgba(0,0,0,0.75)', border: 'none', borderRadius: '50%', width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#fff' }}>
                                        <X size={13} />
                                    </button>
                                    <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, background: 'linear-gradient(transparent, rgba(0,0,0,0.85))', padding: '0.6rem 0.75rem 0.5rem', fontSize: '0.65rem', color: '#fff', fontWeight: 600 }}>
                                        ✓ {kvFile?.name}
                                    </div>
                                </div>
                            ) : (
                                <div
                                    onDragEnter={() => setIsDraggingKv(true)}
                                    onDragLeave={() => setIsDraggingKv(false)}
                                    onDragOver={e => e.preventDefault()}
                                    onDrop={onKvDrop}
                                    onClick={() => kvInputRef.current?.click()}
                                    style={{ border: `2px dashed ${isDraggingKv ? ACCENT : 'var(--z-border-strong)'}`, borderRadius: 10, padding: '2rem 1rem', textAlign: 'center', cursor: 'pointer', background: isDraggingKv ? accentA(0.05) : 'var(--z-bg)', transition: 'all 0.18s' }}>
                                    <Upload size={28} color={isDraggingKv ? ACCENT : 'var(--z-text-muted)'} style={{ margin: '0 auto 0.6rem' }} />
                                    <div style={{ fontSize: '0.9rem', fontWeight: 700, color: 'var(--z-text-secondary)', marginBottom: '0.25rem' }}>Sube el KV de referencia</div>
                                    <div style={{ fontSize: '0.72rem', color: 'var(--z-text-muted)' }}>Arrastra aquí o haz clic · JPG, PNG</div>
                                </div>
                            )}
                            <input ref={kvInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={e => { const f = e.target.files?.[0]; if (f) handleKvFile(f); }} />

                            {kvPreview && mode === 'manual' && (
                                <div style={{ marginTop: '0.75rem' }}>
                                    <div style={{ fontSize: '0.62rem', color: 'var(--z-text-muted)', marginBottom: '0.4rem' }}>
                                        Zonas detectadas automáticamente desde tu KV — así va cada copy
                                    </div>
                                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: '0.5rem', alignItems: 'center' }}>
                                        {ZONE_LABELS.map(z => (
                                            <div key={z.key}
                                                style={{
                                                    fontSize: '0.62rem', fontWeight: 700, padding: '4px 9px', borderRadius: 6,
                                                    border: `1.5px solid ${z.color}`,
                                                    background: manualZones[z.key] ? `${z.color}22` : 'transparent',
                                                    color: z.color,
                                                }}>
                                                {manualZones[z.key] ? '✓ ' : '· '}{z.name}
                                            </div>
                                        ))}
                                        {benefits.length < 6 && (
                                            <button onClick={addBenefit} title="Agregar otro pill de beneficio"
                                                style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: '0.62rem', fontWeight: 700, padding: '4px 9px', borderRadius: 6, cursor: 'pointer', border: '1.5px dashed #16a34a', background: 'transparent', color: '#16a34a' }}>
                                                <Plus size={11} /> Beneficio
                                            </button>
                                        )}
                                        {Object.keys(manualZones).length > 0 && (
                                            <button onClick={() => setManualZones({})} style={{ fontSize: '0.62rem', color: 'var(--z-text-muted)', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}>
                                                Restablecer automático
                                            </button>
                                        )}
                                    </div>
                                    <div
                                        ref={kvImageBoxRef}
                                        style={{ position: 'relative', borderRadius: 8, overflow: 'hidden', border: '1px solid var(--z-border)', userSelect: 'none' }}>
                                        <img src={kvPreview} alt="KV zonas" draggable={false} style={{ width: '100%', display: 'block', maxHeight: 260, objectFit: 'contain', background: '#111', pointerEvents: 'none' }} />
                                        {ZONE_LABELS.map(z => {
                                            const zone = manualZones[z.key];
                                            if (!zone) return null;
                                            return (
                                                <div key={z.key} style={{
                                                    position: 'absolute', left: `${zone.x}%`, top: `${zone.y}%`, width: `${zone.w}%`, height: `${zone.h}%`,
                                                    border: `2px solid ${z.color}`, background: `${z.color}22`, pointerEvents: 'none',
                                                }}>
                                                    <span style={{ position: 'absolute', top: -1, left: -1, fontSize: '0.55rem', fontWeight: 800, color: '#fff', background: z.color, padding: '1px 4px', whiteSpace: 'nowrap' }}>
                                                        {z.name}
                                                    </span>
                                                    <button onClick={() => removeZone(z.key)} style={{ position: 'absolute', top: -1, right: -1, pointerEvents: 'auto', background: z.color, border: 'none', color: '#fff', width: 14, height: 14, fontSize: 9, cursor: 'pointer', lineHeight: '14px' }}>×</button>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            )}
                        </div>

                        {/* ── 2. Fotos del Producto — grid 15 slots (oculto en modo Automático,
                             no hace falta para ese flujo simplificado) ──────── */}
                        <div style={{ display: mode === 'auto' ? 'none' : undefined }}>
                            <div style={{ fontSize: '0.65rem', fontWeight: 800, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--z-text-muted)', marginBottom: '0.4rem' }}>
                                2 · Fotos del producto
                                <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0, color: 'var(--z-text-muted)', fontSize: '0.58rem' }}> opcional · hasta 15 ángulos · mejora fidelidad</span>
                                {productFiles.length > 0 && <span style={{ marginLeft: 6, color: '#f59e0b', fontWeight: 700 }}>{productFiles.length}/15</span>}
                            </div>
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(48px, 1fr))', gap: 5, marginBottom: 5 }}>
                                {Array.from({ length: 15 }).map((_, i) => {
                                    const file = productFiles[i];
                                    const url  = productPreviews?.[i] || '';
                                    const addPhoto = () => {
                                        const inp = document.createElement('input');
                                        inp.type = 'file'; inp.accept = 'image/*'; inp.multiple = true;
                                        inp.onchange = (e: any) => {
                                            const files = Array.from(e.target.files as FileList) as File[];
                                            if (!files.length) return;
                                            files.forEach(f => { const r = new FileReader(); r.onload = ev => setProductPreviews(p => [...(p||[]), ev.target?.result as string]); r.readAsDataURL(f); });
                                            setProductFiles(prev => [...prev, ...files].slice(0, 15));
                                        };
                                        inp.click();
                                    };
                                    if (file) return (
                                        <div key={i} style={{ position: 'relative', borderRadius: 7, overflow: 'hidden', border: '2px solid #f59e0b', aspectRatio: '1' }}>
                                            <img src={url} alt={file.name} style={{ width: '100%', height: '100%', objectFit: 'contain', background: 'var(--z-bg-secondary)' }} />
                                            <button onClick={() => { setProductFiles(prev => prev.filter((_, j) => j !== i)); setProductPreviews(prev => prev?.filter((_, j) => j !== i)); }}
                                                style={{ position: 'absolute', top: 2, right: 2, background: 'rgba(0,0,0,0.75)', border: 'none', borderRadius: '50%', width: 16, height: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#fff' }}>
                                                <X size={8} />
                                            </button>
                                        </div>
                                    );
                                    return (
                                        <div key={i} onClick={addPhoto}
                                            style={{ border: `2px dashed ${i === productFiles.length ? '#f59e0b' : 'var(--z-border)'}`, borderRadius: 7, aspectRatio: '1', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', background: i === productFiles.length ? 'rgba(245,158,11,0.06)' : 'transparent', fontSize: i === productFiles.length ? '1rem' : '0.7rem', color: i === productFiles.length ? '#f59e0b' : 'var(--z-border)', transition: 'all 0.15s' }}>
                                            {i === productFiles.length ? '+' : <span style={{ fontSize: '0.55rem' }}>{i + 1}</span>}
                                        </div>
                                    );
                                })}
                            </div>
                            <div style={{ fontSize: '0.58rem', color: productFiles.length > 0 ? '#f59e0b' : 'var(--z-text-muted)' }}>
                                {productFiles.length > 0 ? `✓ ${productFiles.length} ángulo${productFiles.length !== 1 ? 's' : ''} cargado${productFiles.length !== 1 ? 's' : ''} — haz clic en cualquier slot vacío para agregar más` : 'Haz clic en el slot 1 para subir fotos del producto — fondo blanco o recortado'}
                            </div>
                        </div>

                        {/* ── Enseñale tu marca — agrupa los 3 conceptos que antes se sentían
                             separados (logo / zona de nombre / aprender marca) bajo una sola
                             explicación, para que quede claro qué hace cada uno y cuál usar. ── */}
                        <div style={{ padding: '0.6rem 0.75rem', background: 'var(--z-bg-secondary)', borderRadius: 8, fontSize: '0.65rem', color: 'var(--z-text-muted)', lineHeight: 1.5 }}>
                            <strong style={{ color: 'var(--z-text)' }}>Enseñale tu marca:</strong> subí el archivo del logo acá si lo tenés (se pega exacto, pixel a pixel). Si no lo tenés, no pasa nada — más abajo en "Perfil de marca" podés aprender los colores/tipografía de tu marca a partir de tus KVs, y el nombre se escribe con esa misma tipografía.
                        </div>

                        {/* ── Logo de marca (opcional) — para que el logo se reproduzca fiel ── */}
                        <div>
                            <div style={{ fontSize: '0.65rem', fontWeight: 800, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--z-text-muted)', marginBottom: '0.5rem' }}>
                                Logo de marca <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0, color: 'var(--z-text-muted)', fontSize: '0.58rem' }}> opcional · se reproduce fiel, sin reinventarlo</span>
                            </div>
                            {logoFile ? (
                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', padding: '0.5rem 0.7rem', background: 'var(--z-bg)', borderRadius: 8, border: '2px solid #10b981' }}>
                                    <img src={logoPreview} alt="logo" style={{ width: 36, height: 36, objectFit: 'contain', borderRadius: 5, background: 'var(--z-bg-secondary)' }} />
                                    <span style={{ flex: 1, fontSize: '0.75rem', fontWeight: 600, color: 'var(--z-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{logoFile.name}</span>
                                    <button onClick={() => { setLogoFile(null); setLogoPreview(''); }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--z-text-muted)', display: 'flex', padding: 0 }}><X size={15} /></button>
                                </div>
                            ) : (
                                <div onClick={() => {
                                    const inp = document.createElement('input');
                                    inp.type = 'file'; inp.accept = 'image/*';
                                    inp.onchange = (e: any) => {
                                        const f = e.target.files?.[0]; if (!f) return;
                                        setLogoFile(f);
                                        const r = new FileReader(); r.onload = ev => setLogoPreview(ev.target?.result as string); r.readAsDataURL(f);
                                    };
                                    inp.click();
                                }} style={{ border: '2px dashed var(--z-border)', borderRadius: 8, padding: '0.7rem', textAlign: 'center', cursor: 'pointer', fontSize: '0.72rem', color: 'var(--z-text-muted)' }}>
                                    Subir logo — fondo transparente o blanco, ideal PNG
                                </div>
                            )}
                        </div>

                        {/* ── Logo del conglomerado (opcional) — ej. "Una empresa de..." ── */}
                        <div>
                            <div style={{ fontSize: '0.65rem', fontWeight: 800, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--z-text-muted)', marginBottom: '0.5rem' }}>
                                Logo del conglomerado <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0, color: 'var(--z-text-muted)', fontSize: '0.58rem' }}> opcional · ej. "Una empresa de Grupo X"</span>
                            </div>
                            {conglomerateLogoFile ? (
                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', padding: '0.5rem 0.7rem', background: 'var(--z-bg)', borderRadius: 8, border: '2px solid #10b981' }}>
                                    <img src={conglomerateLogoPreview} alt="logo conglomerado" style={{ width: 36, height: 36, objectFit: 'contain', borderRadius: 5, background: 'var(--z-bg-secondary)' }} />
                                    <span style={{ flex: 1, fontSize: '0.75rem', fontWeight: 600, color: 'var(--z-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{conglomerateLogoFile.name}</span>
                                    <button onClick={() => { setConglomerateLogoFile(null); setConglomerateLogoPreview(''); }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--z-text-muted)', display: 'flex', padding: 0 }}><X size={15} /></button>
                                </div>
                            ) : (
                                <div onClick={() => {
                                    const inp = document.createElement('input');
                                    inp.type = 'file'; inp.accept = 'image/*';
                                    inp.onchange = (e: any) => {
                                        const f = e.target.files?.[0]; if (!f) return;
                                        setConglomerateLogoFile(f);
                                        const r = new FileReader(); r.onload = ev => setConglomerateLogoPreview(ev.target?.result as string); r.readAsDataURL(f);
                                    };
                                    inp.click();
                                }} style={{ border: '2px dashed var(--z-border)', borderRadius: 8, padding: '0.7rem', textAlign: 'center', cursor: 'pointer', fontSize: '0.72rem', color: 'var(--z-text-muted)' }}>
                                    Subir logo del conglomerado — fondo transparente o blanco, ideal PNG
                                </div>
                            )}
                        </div>

                        {/* ── Badges/sellos adicionales (opcional, cualquiera) — genérico para
                             cualquier marca: fabricante, certificación, íconos de cumplimiento, etc. ── */}
                        <div>
                            <div style={{ fontSize: '0.65rem', fontWeight: 800, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--z-text-muted)', marginBottom: '0.5rem' }}>
                                Badges / sellos adicionales <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0, color: 'var(--z-text-muted)', fontSize: '0.58rem' }}> opcional · ej. badge de fabricante, certificación, íconos de cumplimiento — cualquier marca</span>
                            </div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                                {extraBadges.map((b, i) => (
                                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', padding: '0.5rem 0.7rem', background: 'var(--z-bg)', borderRadius: 8, border: '2px solid #10b981' }}>
                                        <img src={b.preview} alt={b.name} style={{ width: 36, height: 36, objectFit: 'contain', borderRadius: 5, background: 'var(--z-bg-secondary)' }} />
                                        <span style={{ flex: 1, fontSize: '0.75rem', fontWeight: 600, color: 'var(--z-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.name}</span>
                                        <button onClick={() => removeExtraBadge(i)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--z-text-muted)', display: 'flex', padding: 0 }}><X size={15} /></button>
                                    </div>
                                ))}
                                <div onClick={() => {
                                    const inp = document.createElement('input');
                                    inp.type = 'file'; inp.accept = 'image/*';
                                    inp.onchange = (e: any) => {
                                        const f = e.target.files?.[0]; if (!f) return;
                                        const name = window.prompt('Nombre del badge (ej: "Certificación de calidad", "Íconos de cumplimiento")', `Badge ${extraBadges.length + 1}`) || `Badge ${extraBadges.length + 1}`;
                                        addExtraBadge(f, name);
                                    };
                                    inp.click();
                                }} style={{ border: '2px dashed var(--z-border)', borderRadius: 8, padding: '0.7rem', textAlign: 'center', cursor: 'pointer', fontSize: '0.72rem', color: 'var(--z-text-muted)' }}>
                                    + Agregar badge — fondo transparente o blanco, ideal PNG
                                </div>
                            </div>
                        </div>

                        {/* ── 3. Perfil de marca (oculto en modo Automático) ────────────── */}
                        <div style={{ display: mode === 'auto' ? 'none' : undefined }}>
                            <div style={{ fontSize: '0.65rem', fontWeight: 800, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--z-text-muted)', marginBottom: '0.6rem' }}>
                                3 · Perfil de marca
                            </div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                                {profiles.map(p => (
                                    <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                                        <button onClick={() => {
                                            setBrandProfile(p.id);
                                            setSelectedProfileIdentity((p as any).analysisSummary && Object.keys((p as any).analysisSummary).length > 1 ? JSON.stringify((p as any).analysisSummary) : p.identityPrompt);
                                            setSelectedProfileQaRules((p as any).qaRules || []);
                                            setSelectedProductCategory(p.productCategory || (p as any).analysisSummary?.productCategory || '');
                                            setSelectedProductBenefits(p.productBenefits || (p as any).analysisSummary?.productBenefits || []);
                                            setResults([]); setGenStatus('idle');
                                        }} style={{ flex: 1, display: 'flex', alignItems: 'center', gap: '0.7rem', padding: '0.7rem 0.85rem', borderRadius: 9, border: `2px solid ${brandProfile === p.id ? p.color : 'var(--z-border)'}`, background: brandProfile === p.id ? `${p.color}12` : 'var(--z-bg)', cursor: 'pointer', textAlign: 'left', transition: 'all 0.15s' }}>
                                            <div style={{ width: 28, height: 28, borderRadius: 7, background: brandProfile === p.id ? p.color : 'var(--z-border)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.9rem', flexShrink: 0 }}>{p.emoji}</div>
                                            <div style={{ minWidth: 0 }}>
                                                <div style={{ fontSize: '0.78rem', fontWeight: 700, color: brandProfile === p.id ? p.color : 'var(--z-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</div>
                                                {p.type === 'saved' && p.kvCount && <div style={{ fontSize: '0.58rem', color: 'var(--z-text-muted)' }}>{p.kvCount} KVs · Identidad aprendida</div>}
                                                {p.type === 'builtin' && p.id === 'generic' && <div style={{ fontSize: '0.58rem', color: 'var(--z-text-muted)' }}>Identidad desde KV</div>}
                                            </div>
                                        </button>
                                        {p.type === 'saved' && (
                                            <button onClick={async () => {
                                                if (!confirm(`¿Eliminar perfil "${p.name}"?`)) return;
                                                try {
                                                    const res = await fetch(`${API_BASE}/api/dco/profiles/${p.id}`, { method: 'DELETE', headers: authedHeaders(), signal: AbortSignal.timeout(15000) });
                                                    if (!res.ok) throw new Error(`Backend respondió ${res.status}`);
                                                    setProfiles(prev => prev.filter(x => x.id !== p.id));
                                                    if (brandProfile === p.id) { setBrandProfile('generic'); setSelectedProfileIdentity(undefined); }
                                                } catch (e: any) {
                                                    alert(`No se pudo eliminar el perfil: ${e.message || 'error de conexión'}`);
                                                }
                                            }} title="Eliminar perfil" style={{ padding: '4px 7px', background: 'none', border: '1px solid var(--z-border)', borderRadius: 6, cursor: 'pointer', fontSize: '0.7rem', color: '#ef4444', flexShrink: 0 }}>✕</button>
                                        )}
                                    </div>
                                ))}
                                {/* Botón aprender nueva marca */}
                                <button onClick={() => { setLearnStep('upload'); setLearnFiles([]); setLearnAnalysis(null); setNewProfileName(''); }}
                                    style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.4rem', padding: '0.6rem', borderRadius: 9, border: '2px dashed var(--z-border)', background: 'none', cursor: 'pointer', fontSize: '0.72rem', color: 'var(--z-text-muted)', fontWeight: 600 }}>
                                    + Aprender nueva marca
                                </button>
                            </div>
                        </div>

                        {/* ── 3b. Personaje (opcional) ────────────────────── */}
                        <div>
                            <div style={{ fontSize: '0.65rem', fontWeight: 800, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--z-text-muted)', marginBottom: '0.6rem' }}>
                                Personaje (opcional) — consistencia entre piezas
                            </div>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                                <button onClick={() => setCharacterId('')}
                                    style={{ padding: '0.5rem 0.8rem', borderRadius: 9, border: `2px solid ${characterId === '' ? '#a78bfa' : 'var(--z-border)'}`, background: characterId === '' ? 'rgba(167,139,250,0.1)' : 'var(--z-bg)', cursor: 'pointer', fontSize: '0.72rem', fontWeight: 600, color: characterId === '' ? '#a78bfa' : 'var(--z-text-muted)' }}>
                                    Ninguno
                                </button>
                                {characters.map(ch => (
                                    <div key={ch.id} style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                                        <button onClick={() => setCharacterId(ch.id)}
                                            style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', padding: '0.35rem 0.7rem 0.35rem 0.35rem', borderRadius: 9, border: `2px solid ${characterId === ch.id ? '#a78bfa' : 'var(--z-border)'}`, background: characterId === ch.id ? 'rgba(167,139,250,0.1)' : 'var(--z-bg)', cursor: 'pointer' }}>
                                            <img src={ch.referencePhotoUrl} alt={ch.name} style={{ width: 26, height: 26, borderRadius: '50%', objectFit: 'cover' }} />
                                            <span style={{ fontSize: '0.72rem', fontWeight: 600, color: characterId === ch.id ? '#a78bfa' : 'var(--z-text)' }}>{ch.name}</span>
                                        </button>
                                        <button onClick={async () => {
                                            if (!confirm(`¿Eliminar personaje "${ch.name}"?`)) return;
                                            try {
                                                const res = await fetch(`${API_BASE}/api/dco/characters/${ch.id}`, { method: 'DELETE', headers: authedHeaders(), signal: AbortSignal.timeout(15000) });
                                                if (!res.ok) throw new Error(`Backend respondió ${res.status}`);
                                                setCharacters(prev => prev.filter(x => x.id !== ch.id));
                                                if (characterId === ch.id) setCharacterId('');
                                            } catch (e: any) {
                                                alert(`No se pudo eliminar el personaje: ${e.message || 'error de conexión'}`);
                                            }
                                        }} title="Eliminar personaje" style={{ padding: '4px 7px', background: 'none', border: '1px solid var(--z-border)', borderRadius: 6, cursor: 'pointer', fontSize: '0.65rem', color: '#ef4444' }}>✕</button>
                                    </div>
                                ))}
                                <button onClick={() => { setNewCharacterModal(true); setNewCharacterName(''); setNewCharacterFile(null); setNewCharacterPreview(''); }}
                                    style={{ padding: '0.5rem 0.8rem', borderRadius: 9, border: '2px dashed var(--z-border)', background: 'none', cursor: 'pointer', fontSize: '0.72rem', color: 'var(--z-text-muted)', fontWeight: 600 }}>
                                    + Nuevo personaje
                                </button>
                            </div>
                        </div>

                        {/* ── Modal: Nuevo personaje ───────────────────── */}
                        {newCharacterModal && (
                            <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
                                <div style={{ background: 'var(--z-bg)', border: '1px solid var(--z-border)', borderRadius: 12, padding: '1.5rem', width: 380, maxWidth: '90vw' }}>
                                    <div style={{ fontSize: '0.95rem', fontWeight: 700, marginBottom: '1rem', color: 'var(--z-text)' }}>Nuevo personaje</div>
                                    <input value={newCharacterName} onChange={e => setNewCharacterName(e.target.value)} placeholder="Nombre (ej: Personaje principal, Vocero oficial)"
                                        style={{ width: '100%', padding: '0.6rem 0.8rem', borderRadius: 8, border: '1px solid var(--z-border)', background: 'var(--z-bg-secondary)', color: 'var(--z-text)', fontSize: '0.8rem', marginBottom: '0.8rem' }} />
                                    <div onClick={() => {
                                        const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*';
                                        inp.onchange = () => {
                                            const f = inp.files?.[0]; if (!f) return;
                                            setNewCharacterFile(f);
                                            const r = new FileReader(); r.onload = ev => setNewCharacterPreview(ev.target?.result as string); r.readAsDataURL(f);
                                        };
                                        inp.click();
                                    }} style={{ border: '2px dashed var(--z-border)', borderRadius: 9, aspectRatio: '1', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', marginBottom: '1rem', overflow: 'hidden', background: 'var(--z-bg-secondary)' }}>
                                        {newCharacterPreview
                                            ? <img src={newCharacterPreview} alt="preview" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                                            : <span style={{ fontSize: '0.72rem', color: 'var(--z-text-muted)' }}>Foto de referencia — clic para subir</span>}
                                    </div>
                                    <div style={{ display: 'flex', gap: '0.6rem' }}>
                                        <button onClick={() => setNewCharacterModal(false)} style={{ flex: 1, padding: '0.6rem', borderRadius: 8, border: '1px solid var(--z-border)', background: 'none', cursor: 'pointer', fontSize: '0.78rem', color: 'var(--z-text-muted)' }}>Cancelar</button>
                                        <button disabled={!newCharacterName.trim() || !newCharacterFile || savingCharacter} onClick={async () => {
                                            if (!newCharacterName.trim() || !newCharacterFile) return;
                                            setSavingCharacter(true);
                                            try {
                                                const fd = new FormData();
                                                fd.append('name', newCharacterName.trim());
                                                fd.append('photo', newCharacterFile);
                                                const res = await fetch(`${API_BASE}/api/dco/characters`, { method: 'POST', headers: authedHeaders(), body: fd });
                                                const data = await res.json();
                                                if (data.character) {
                                                    setCharacters(prev => [data.character, ...prev]);
                                                    setCharacterId(data.character.id);
                                                    setNewCharacterModal(false);
                                                }
                                            } finally { setSavingCharacter(false); }
                                        }} style={{ flex: 1, padding: '0.6rem', borderRadius: 8, border: 'none', background: '#a78bfa', cursor: (!newCharacterName.trim() || !newCharacterFile) ? 'not-allowed' : 'pointer', opacity: (!newCharacterName.trim() || !newCharacterFile) ? 0.5 : 1, fontSize: '0.78rem', fontWeight: 700, color: '#fff' }}>
                                            {savingCharacter ? 'Guardando...' : 'Crear'}
                                        </button>
                                    </div>
                                </div>
                            </div>
                        )}

                        {/* ── Modal: Learn Brand ───────────────────────── */}
                        {learnStep && (
                            <div style={{ position: 'fixed', inset: 0, zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(4px)' }}>
                                <div style={{ background: 'var(--z-surface)', border: '1px solid var(--z-border)', borderRadius: 14, padding: '1.75rem', width: '90%', maxWidth: 520, maxHeight: '85vh', overflowY: 'auto', boxShadow: '0 24px 60px rgba(0,0,0,0.6)' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.2rem' }}>
                                        <div style={{ fontSize: '0.95rem', fontWeight: 800, color: 'var(--z-text)', letterSpacing: '0.04em' }}>
                                            {learnStep === 'upload' && '📚 Aprender marca desde KVs'}
                                            {learnStep === 'analyzing' && '🔍 Analizando identidad...'}
                                            {learnStep === 'review' && '✅ Identidad extraída'}
                                            {learnStep === 'saving' && '💾 Guardar perfil'}
                                        </div>
                                        <button onClick={() => setLearnStep(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--z-text-muted)', fontSize: '1.1rem' }}>✕</button>
                                    </div>

                                    {/* UPLOAD STEP */}
                                    {learnStep === 'upload' && (
                                        <>
                                            <p style={{ fontSize: '0.75rem', color: 'var(--z-text-secondary)', marginBottom: '1rem', lineHeight: 1.5 }}>
                                                Sube entre 5 y 20 KVs finales de la marca. El sistema los analizará para extraer colores, tipografía, layout, estructura de copy y todos los elementos visuales de identidad.
                                            </p>
                                            <div
                                                onClick={() => learnInputRef.current?.click()}
                                                style={{ border: '2px dashed var(--z-border-strong)', borderRadius: 10, padding: '1.5rem', textAlign: 'center', cursor: 'pointer', marginBottom: '0.8rem', background: learnFiles.length > 0 ? 'rgba(34,197,94,0.05)' : 'var(--z-bg)' }}>
                                                <Upload size={24} style={{ margin: '0 auto 0.5rem', color: 'var(--z-text-muted)', display: 'block' }} />
                                                <div style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--z-text)' }}>
                                                    {learnFiles.length > 0 ? `${learnFiles.length} imágenes seleccionadas` : 'Haz clic o arrastra los KVs'}
                                                </div>
                                                <div style={{ fontSize: '0.65rem', color: 'var(--z-text-muted)', marginTop: '0.2rem' }}>JPG, PNG · Máximo 20 KVs</div>
                                            </div>
                                            <input ref={learnInputRef} type="file" accept="image/*" multiple style={{ display: 'none' }}
                                                onChange={e => { const files = Array.from(e.target.files || []).slice(0, 20); setLearnFiles(files); setLearnFileFormats(files.map(() => 'general')); }} />
                                            {learnFiles.length > 0 && (
                                                <div style={{ marginBottom: '0.8rem' }}>
                                                    <div style={{ fontSize: '0.62rem', color: 'var(--z-text-muted)', marginBottom: '0.4rem' }}>
                                                        Marcá el formato de cada KV — así el layout no se mezcla entre formatos distintos (colores/logo sí se aprenden de todos juntos).
                                                    </div>
                                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                                                        {learnFiles.map((f, i) => (
                                                            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.65rem', padding: '3px 7px', background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.4)', borderRadius: 5 }}>
                                                                <span style={{ flex: 1, color: '#22c55e', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name.slice(0, 22)}{f.name.length > 22 ? '…' : ''}</span>
                                                                <select value={learnFileFormats[i] || 'general'}
                                                                    onChange={e => setLearnFileFormats(prev => prev.map((v, j) => j === i ? e.target.value : v))}
                                                                    style={{ fontSize: '0.62rem', padding: '2px 4px', borderRadius: 4, border: '1px solid var(--z-border)', background: 'var(--z-bg)', color: 'var(--z-text)' }}>
                                                                    {KV_FORMAT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                                                                </select>
                                                            </div>
                                                        ))}
                                                    </div>
                                                </div>
                                            )}
                                            <button
                                                disabled={learnFiles.length < 1}
                                                onClick={async () => {
                                                    setLearnStep('analyzing');
                                                    try {
                                                        const fd = new FormData();
                                                        learnFiles.forEach(f => fd.append('kvImages', f));
                                                        learnFileFormats.forEach(fmt => fd.append('kvFormats', fmt));
                                                        // 170s en vez de 120s: cubre además un cold start del backend (free/cheap
                                                        // tier puede tardar 20-50s en despertar) sumado a los 30-60s reales del
                                                        // análisis visual — antes el timeout podía ganarle al análisis real.
                                                        const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 170000);
                                                        const res = await fetch(`${API_BASE}/api/dco/analyze-brand`, { method: 'POST', headers: authedHeaders(), body: fd, signal: ctrl.signal });
                                                        clearTimeout(t);
                                                        const data = await res.json();
                                                        if (!data.ok) { alert('Error: ' + (data.error || 'desconocido')); setLearnStep('upload'); return; }
                                                        setLearnAnalysis(data.analysis);
                                                        setNewProfileName(data.analysis.brandName || '');
                                                        setNewProfileColor(data.analysis.primaryColor || '#6b7280');
                                                        // Primer borrador de zonas ya ajustado a ESTE KV (headline/logo/beneficios
                                                        // ubicados según lo que el análisis detectó) — el usuario arrastra para
                                                        // corregir en vez de dibujar 8-14 cajas desde cero.
                                                        if (data.proposedZones && Object.keys(data.proposedZones).length) {
                                                            setManualZones(prev => ({ ...data.proposedZones, ...prev }));
                                                        }
                                                        setLearnStep('review');
                                                    } catch (e: any) {
                                                        alert(e.name === 'AbortError' ? 'El servidor tardó demasiado (¿estaba dormido?) — intenta de nuevo.' : ('Error: ' + e.message));
                                                        setLearnStep('upload');
                                                    }
                                                }}
                                                style={{ width: '100%', padding: '0.75rem', background: learnFiles.length >= 1 ? ACCENT : 'var(--z-border)', color: '#fff', border: 'none', borderRadius: 9, fontWeight: 800, fontSize: '0.78rem', cursor: learnFiles.length >= 1 ? 'pointer' : 'default', textTransform: 'uppercase', letterSpacing: '0.1em' }}>
                                                Analizar {learnFiles.length} KV{learnFiles.length !== 1 ? 's' : ''}
                                            </button>
                                        </>
                                    )}

                                    {/* ANALYZING STEP */}
                                    {learnStep === 'analyzing' && (
                                        <div style={{ textAlign: 'center', padding: '2rem 0' }}>
                                            <Loader2 size={36} style={{ animation: 'spin 1s linear infinite', color: ACCENT, margin: '0 auto 1rem', display: 'block' }} />
                                            <div style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--z-text)', marginBottom: '0.4rem' }}>Analizando {learnFiles.length} KVs</div>
                                            <div style={{ fontSize: '0.72rem', color: 'var(--z-text-muted)' }}>Extrayendo colores, layout, copy, elementos fijos... esto puede tardar 30-60 segundos.</div>
                                        </div>
                                    )}

                                    {/* REVIEW STEP */}
                                    {learnStep === 'review' && learnAnalysis && (
                                        <>
                                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem', marginBottom: '1rem' }}>
                                                {[
                                                    { label: 'Marca', value: learnAnalysis.brandName },
                                                    { label: 'Color primario', value: learnAnalysis.primaryColor, isColor: true },
                                                    { label: 'Color acento', value: learnAnalysis.accentColor, isColor: true },
                                                    { label: 'Badge shape', value: learnAnalysis.badgeShape },
                                                    { label: 'Banda color', value: learnAnalysis.bandColor, isColor: true },
                                                    { label: 'Banda posición', value: learnAnalysis.bandPosition },
                                                ].map(f => f.value ? (
                                                    <div key={f.label} style={{ padding: '0.5rem 0.75rem', background: 'var(--z-bg)', borderRadius: 8, border: '1px solid var(--z-border)' }}>
                                                        <div style={{ fontSize: '0.58rem', color: 'var(--z-text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '0.2rem' }}>{f.label}</div>
                                                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                                                            {(f as any).isColor && <div style={{ width: 14, height: 14, borderRadius: 3, background: f.value, border: '1px solid var(--z-border)', flexShrink: 0 }} />}
                                                            <span style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--z-text)' }}>{f.value}</span>
                                                        </div>
                                                    </div>
                                                ) : null)}
                                            </div>
                                            {learnAnalysis.copyStructure && (
                                                <div style={{ padding: '0.6rem 0.75rem', background: 'var(--z-bg)', borderRadius: 8, border: '1px solid var(--z-border)', marginBottom: '0.5rem' }}>
                                                    <div style={{ fontSize: '0.58rem', color: 'var(--z-text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '0.2rem' }}>Estructura de copy</div>
                                                    <div style={{ fontSize: '0.68rem', color: 'var(--z-text)', lineHeight: 1.4 }}>{learnAnalysis.copyStructure}</div>
                                                </div>
                                            )}
                                            {learnAnalysis.photographyStyle && (
                                                <div style={{ padding: '0.6rem 0.75rem', background: 'var(--z-bg)', borderRadius: 8, border: '1px solid var(--z-border)', marginBottom: '1rem' }}>
                                                    <div style={{ fontSize: '0.58rem', color: 'var(--z-text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '0.2rem' }}>Estilo fotográfico</div>
                                                    <div style={{ fontSize: '0.68rem', color: 'var(--z-text)', lineHeight: 1.4 }}>{learnAnalysis.photographyStyle}</div>
                                                </div>
                                            )}
                                            <div style={{ display: 'flex', gap: '0.5rem' }}>
                                                <button onClick={() => setLearnStep('upload')} style={{ padding: '0.6rem 1rem', background: 'none', border: '1px solid var(--z-border)', borderRadius: 8, fontSize: '0.72rem', cursor: 'pointer', color: 'var(--z-text-muted)' }}>← Volver</button>
                                                <button onClick={() => setLearnStep('saving')} style={{ flex: 1, padding: '0.6rem', background: '#22c55e', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 800, fontSize: '0.75rem', cursor: 'pointer' }}>Guardar este perfil →</button>
                                            </div>
                                        </>
                                    )}

                                    {/* SAVING STEP */}
                                    {learnStep === 'saving' && (
                                        <>
                                            <div style={{ marginBottom: '0.8rem' }}>
                                                <label style={{ fontSize: '0.65rem', fontWeight: 700, color: 'var(--z-text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', display: 'block', marginBottom: '0.3rem' }}>Nombre de la marca</label>
                                                <input value={newProfileName} onChange={e => setNewProfileName(e.target.value)} placeholder="Ej: Nombre de tu marca"
                                                    style={{ width: '100%', padding: '0.6rem 0.75rem', background: 'var(--z-bg)', border: '1px solid var(--z-border)', borderRadius: 8, color: 'var(--z-text)', fontSize: '0.85rem', fontWeight: 700, outline: 'none', boxSizing: 'border-box' }} />
                                            </div>
                                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem', marginBottom: '1rem' }}>
                                                <div>
                                                    <label style={{ fontSize: '0.65rem', fontWeight: 700, color: 'var(--z-text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', display: 'block', marginBottom: '0.3rem' }}>Emoji</label>
                                                    <input value={newProfileEmoji} onChange={e => setNewProfileEmoji(e.target.value)} maxLength={2}
                                                        style={{ width: '100%', padding: '0.6rem', background: 'var(--z-bg)', border: '1px solid var(--z-border)', borderRadius: 8, color: 'var(--z-text)', fontSize: '1.2rem', textAlign: 'center', outline: 'none', boxSizing: 'border-box' }} />
                                                </div>
                                                <div>
                                                    <label style={{ fontSize: '0.65rem', fontWeight: 700, color: 'var(--z-text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', display: 'block', marginBottom: '0.3rem' }}>Color de marca</label>
                                                    <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
                                                        <input type="color" value={newProfileColor} onChange={e => setNewProfileColor(e.target.value)} style={{ width: 36, height: 36, border: 'none', borderRadius: 6, cursor: 'pointer', padding: 2 }} />
                                                        <span style={{ fontSize: '0.72rem', color: 'var(--z-text)', fontWeight: 600 }}>{newProfileColor}</span>
                                                    </div>
                                                </div>
                                            </div>
                                            <button
                                                disabled={!newProfileName.trim()}
                                                onClick={async () => {
                                                    try {
                                                        // Email del usuario logueado provisto por el host — sin leer localStorage directamente.
                                                        const userEmail = currentUserEmail || '';
                                                        const res = await fetch(`${API_BASE}/api/dco/save-profile`, {
                                                            method: 'POST',
                                                            headers: authedHeaders({ 'Content-Type': 'application/json' }),
                                                            body: JSON.stringify({
                                                                name: newProfileName.trim(),
                                                                color: newProfileColor,
                                                                emoji: newProfileEmoji,
                                                                identityPrompt: learnAnalysis.identityPrompt,
                                                                analysisSummary: learnAnalysis,
                                                                qaRules: learnAnalysis.qaRules || [],
                                                                kvCount: learnFiles.length,
                                                                createdBy: userEmail,
                                                            }),
                                                        });
                                                        const data = await res.json();
                                                        if (!data.ok) { alert('Error: ' + data.error); return; }
                                                        const newProfile: ProfileEntry = {
                                                            id: data.profile.id,
                                                            name: newProfileName.trim(),
                                                            emoji: newProfileEmoji,
                                                            color: newProfileColor,
                                                            type: 'saved',
                                                            kvCount: learnFiles.length,
                                                            identityPrompt: learnAnalysis.identityPrompt,
                                                        };
                                                        setProfiles(prev => [...prev, { ...newProfile, qaRules: learnAnalysis.qaRules || [] }]);
                                                        setBrandProfile(newProfile.id);
                                                        setSelectedProfileIdentity(JSON.stringify(learnAnalysis));
                                                        setSelectedProfileQaRules(learnAnalysis.qaRules || []);
                                                        setSelectedProductCategory(learnAnalysis.productCategory || '');
                                                        setSelectedProductBenefits(learnAnalysis.productBenefits || []);
                                                        setLearnStep(null);
                                                    } catch (e: any) { alert('Error al guardar: ' + e.message); }
                                                }}
                                                style={{ width: '100%', padding: '0.75rem', background: newProfileName.trim() ? '#22c55e' : 'var(--z-border)', color: '#fff', border: 'none', borderRadius: 9, fontWeight: 800, fontSize: '0.78rem', cursor: newProfileName.trim() ? 'pointer' : 'default', textTransform: 'uppercase', letterSpacing: '0.1em' }}>
                                                Guardar perfil de marca
                                            </button>
                                        </>
                                    )}
                                </div>
                            </div>
                        )}

                        {/* ── 3. Modo — simple por default; Excel/carrusel atrás de "Modo avanzado" ── */}
                        <div>
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.6rem' }}>
                                <div style={{ fontSize: '0.65rem', fontWeight: 800, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--z-text-muted)' }}>
                                    3 · ¿Qué querés crear?
                                </div>
                                {!showAdvancedModes && (
                                    <button onClick={() => setShowAdvancedModes(true)}
                                        style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.62rem', fontWeight: 700, color: 'var(--z-text-muted)', textDecoration: 'underline' }}>
                                        Modo avanzado (Excel / carrusel)
                                    </button>
                                )}
                            </div>
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '0.5rem' }}>
                                {([['auto', '🤖', 'Automático', 'Subís el KV, la IA hace audiencias, copy y foto'], ['manual', '🖼️', 'Una pieza rápida', 'Escribís el mensaje, elegís el tamaño'] , ['brief', '📊', 'Muchas piezas desde Excel', 'Con o sin los textos ya escritos'], ['carousel', '🎠', 'Historia con un personaje', 'Varias escenas, un solo protagonista']] as const)
                                    .filter(([m]) => m === 'manual' || m === 'auto' || showAdvancedModes)
                                    .map(([m, emoji, label, desc]) => {
                                    const active = mode === m || (m === 'brief' && mode === 'copys');
                                    return (
                                        <button key={m} onClick={() => { setMode(m); setResults([]); setGenStatus('idle'); }}
                                            style={{ padding: '0.85rem 0.75rem', borderRadius: 10, border: `2px solid ${active ? ACCENT : 'var(--z-border)'}`, background: active ? accentA(0.06) : 'var(--z-bg)', cursor: 'pointer', textAlign: 'left', transition: 'all 0.15s' }}>
                                            <div style={{ fontSize: '1.3rem', marginBottom: '0.3rem' }}>{emoji}</div>
                                            <div style={{ fontSize: '0.8rem', fontWeight: 700, color: active ? ACCENT : 'var(--z-text)', marginBottom: '0.15rem' }}>{label}</div>
                                            <div style={{ fontSize: '0.65rem', color: 'var(--z-text-muted)', lineHeight: 1.3 }}>{desc}</div>
                                        </button>
                                    );
                                })}
                            </div>
                            {(mode === 'brief' || mode === 'copys') && (
                                <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.6rem' }}>
                                    <button onClick={() => setMode('brief')}
                                        style={{ flex: 1, padding: '0.5rem', borderRadius: 8, border: `2px solid ${mode === 'brief' ? ACCENT : 'var(--z-border)'}`, background: mode === 'brief' ? accentA(0.06) : 'var(--z-bg)', cursor: 'pointer', fontSize: '0.7rem', fontWeight: 700, color: mode === 'brief' ? ACCENT : 'var(--z-text-muted)' }}>
                                        Mi Excel ya tiene los copys
                                    </button>
                                    <button onClick={() => setMode('copys')}
                                        style={{ flex: 1, padding: '0.5rem', borderRadius: 8, border: `2px solid ${mode === 'copys' ? ACCENT : 'var(--z-border)'}`, background: mode === 'copys' ? accentA(0.06) : 'var(--z-bg)', cursor: 'pointer', fontSize: '0.7rem', fontWeight: 700, color: mode === 'copys' ? ACCENT : 'var(--z-text-muted)' }}>
                                        Quiero que generes los copys
                                    </button>
                                </div>
                            )}
                        </div>

                        {/* ── MODO MANUAL ───────────────────────────────── */}
                        {mode === 'manual' && (
                            <>
                                {/* Escena / audiencia */}
                                <div>
                                    <div style={{ fontSize: '0.65rem', fontWeight: 800, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--z-text-muted)', marginBottom: '0.5rem' }}>4 · Audiencia / Escena</div>
                                    <textarea
                                        value={manualCopy.sceneDesc}
                                        onChange={e => updateCopy('sceneDesc', e.target.value)}
                                        placeholder="Ej: Persona sonriente usando el producto al aire libre, luz cálida de atardecer"
                                        rows={2}
                                        style={{ width: '100%', padding: '0.6rem 0.75rem', borderRadius: 8, border: '2px solid var(--z-border)', background: 'var(--z-bg)', color: 'var(--z-text)', fontSize: '0.8rem', resize: 'vertical', outline: 'none', fontFamily: 'inherit', lineHeight: 1.4, boxSizing: 'border-box' }}
                                    />
                                </div>

                                {/* Copy — solo lo esencial visible, el resto detrás de "Más detalles" */}
                                <div>
                                    <div style={{ fontSize: '0.65rem', fontWeight: 800, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--z-text-muted)', marginBottom: '0.5rem' }}>5 · Copy</div>
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                                        {([
                                            { field: 'headline', label: 'Titular *', placeholder: 'Ej: Tu titular aquí', bold: true },
                                            { field: 'cta',      label: 'CTA', placeholder: 'Ej: Tu llamado a la acción' },
                                        ] as { field: keyof typeof manualCopy; label: string; placeholder: string; bold?: boolean; chip?: boolean }[]).map(({ field, label, placeholder, bold, chip }) => (
                                            <div key={field}>
                                                <div style={{ fontSize: '0.6rem', fontWeight: 700, color: chip ? '#b45309' : 'var(--z-text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '0.2rem' }}>{label}</div>
                                                <input
                                                    value={manualCopy[field]}
                                                    onChange={e => updateCopy(field, e.target.value)}
                                                    placeholder={placeholder}
                                                    style={{ width: '100%', padding: '0.55rem 0.75rem', borderRadius: 7, border: `2px solid ${chip ? 'rgba(180,83,9,0.35)' : 'var(--z-border)'}`, background: chip ? 'rgba(255,215,0,0.06)' : 'var(--z-bg)', color: 'var(--z-text)', fontSize: bold ? '0.85rem' : '0.8rem', fontWeight: bold ? 700 : 400, outline: 'none', fontFamily: 'inherit', boxSizing: 'border-box' }}
                                                />
                                            </div>
                                        ))}

                                        <button onClick={() => setShowAdvancedCopy(v => !v)}
                                            style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', background: 'none', border: 'none', cursor: 'pointer', padding: '0.3rem 0', fontSize: '0.7rem', fontWeight: 700, color: ACCENT, alignSelf: 'flex-start' }}>
                                            {showAdvancedCopy ? '− Menos detalles' : '+ Más detalles (opcional)'}
                                        </button>

                                        {showAdvancedCopy && ([
                                            { field: 'subhead', label: 'Subtítulo', placeholder: 'Ej: Tu mensaje secundario' },
                                            { field: 'chip',    label: 'Badge / Chip', placeholder: 'Ej: Badge/sello (opcional)', chip: true },
                                        ] as { field: keyof typeof manualCopy; label: string; placeholder: string; chip?: boolean }[]).map(({ field, label, placeholder, chip }) => (
                                            <div key={field}>
                                                <div style={{ fontSize: '0.6rem', fontWeight: 700, color: chip ? '#b45309' : 'var(--z-text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '0.2rem' }}>{label}</div>
                                                <input
                                                    value={manualCopy[field]}
                                                    onChange={e => updateCopy(field, e.target.value)}
                                                    placeholder={placeholder}
                                                    style={{ width: '100%', padding: '0.55rem 0.75rem', borderRadius: 7, border: `2px solid ${chip ? 'rgba(180,83,9,0.35)' : 'var(--z-border)'}`, background: chip ? 'rgba(255,215,0,0.06)' : 'var(--z-bg)', color: 'var(--z-text)', fontSize: '0.8rem', outline: 'none', fontFamily: 'inherit', boxSizing: 'border-box' }}
                                                />
                                            </div>
                                        ))}

                                        {showAdvancedCopy && (
                                            <div>
                                                <div style={{ fontSize: '0.6rem', fontWeight: 700, color: 'var(--z-text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '0.3rem' }}>
                                                    Beneficios <span style={{ fontWeight: 400, textTransform: 'none' }}>— bullets cortos, ej. "+Rápido", uno por zona marcada</span>
                                                </div>
                                                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                                                    {benefits.map((b, i) => (
                                                        <div key={i} style={{ display: 'flex', gap: '0.35rem', alignItems: 'center' }}>
                                                            <input
                                                                value={b}
                                                                onChange={e => updateBenefit(i, e.target.value)}
                                                                placeholder={`Ej: +Beneficio`}
                                                                style={{ flex: 1, padding: '0.55rem 0.75rem', borderRadius: 7, border: '2px solid var(--z-border)', background: 'var(--z-bg)', color: 'var(--z-text)', fontSize: '0.8rem', outline: 'none', fontFamily: 'inherit', boxSizing: 'border-box' }}
                                                            />
                                                            {benefits.length > 1 && (
                                                                <button onClick={() => removeBenefit(i)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--z-text-muted)', display: 'flex', padding: '0.3rem' }}><X size={14} /></button>
                                                            )}
                                                        </div>
                                                    ))}
                                                    {benefits.length < 6 && (
                                                        <button onClick={addBenefit} style={{ alignSelf: 'flex-start', background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.72rem', fontWeight: 700, color: '#16a34a', padding: '0.2rem 0' }}>
                                                            + Agregar beneficio
                                                        </button>
                                                    )}
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                </div>

                                {/* Motor de imagen */}
                                <div>
                                    <div style={{ fontSize: '0.65rem', fontWeight: 800, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--z-text-muted)', marginBottom: '0.6rem' }}>
                                        Motor de imagen
                                    </div>
                                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                                        {(['gemini', 'gpt'] as const).map(p => (
                                            <button key={p}
                                                onClick={() => {
                                                    setImageProvider(p);
                                                    if (p === 'gpt') setManualFormats(prev => prev.filter(id => !GPT_UNSUPPORTED_FORMATS.includes(id)));
                                                }}
                                                style={{ flex: 1, padding: '0.6rem', borderRadius: 8, border: `2px solid ${imageProvider === p ? ACCENT : 'var(--z-border)'}`, background: imageProvider === p ? accentA(0.06) : 'var(--z-bg)', cursor: 'pointer', fontSize: '0.78rem', fontWeight: 600, color: imageProvider === p ? 'var(--z-text)' : 'var(--z-text-secondary)' }}>
                                                {p === 'gemini' ? 'Gemini (default)' : 'GPT-image (beta)'}
                                            </button>
                                        ))}
                                    </div>
                                    {imageProvider === 'gpt' && (
                                        <div style={{ fontSize: '0.62rem', color: 'var(--z-text-muted)', marginTop: '0.4rem' }}>
                                            GPT-image no soporta los formatos banner (se ocultan abajo) — requiere crédito disponible en la cuenta configurada para ese proveedor.
                                        </div>
                                    )}
                                </div>

                                {/* Formatos */}
                                <div>
                                    <div style={{ fontSize: '0.65rem', fontWeight: 800, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--z-text-muted)', marginBottom: '0.6rem' }}>
                                        6 · Formatos <span style={{ color: manualFormats.length > 0 ? ACCENT : 'var(--z-text-muted)', fontWeight: 400 }}>({manualFormats.length} seleccionados)</span>
                                    </div>
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                                        {FORMATS.filter(f => imageProvider !== 'gpt' || !GPT_UNSUPPORTED_FORMATS.includes(f.id)).map(f => {
                                            const active = manualFormats.includes(f.id);
                                            return (
                                                <button key={f.id}
                                                    onClick={() => setManualFormats(prev => prev.includes(f.id) ? prev.filter(x => x !== f.id) : [...prev, f.id])}
                                                    style={{ display: 'flex', alignItems: 'center', gap: '0.7rem', padding: '0.65rem 0.85rem', borderRadius: 8, border: `2px solid ${active ? ACCENT : 'var(--z-border)'}`, background: active ? accentA(0.06) : 'var(--z-bg)', cursor: 'pointer', transition: 'all 0.15s' }}>
                                                    <div style={{ width: 20, height: 20, borderRadius: 5, border: `2px solid ${active ? ACCENT : 'var(--z-border-strong)'}`, background: active ? ACCENT : 'transparent', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                                        {active && <Check size={11} color="#fff" strokeWidth={3} />}
                                                    </div>
                                                    <div style={{ color: active ? 'var(--z-text)' : 'var(--z-text-secondary)' }}>
                                                        <FormatShape formatId={f.id} />
                                                    </div>
                                                    <div style={{ flex: 1, textAlign: 'left' }}>
                                                        <div style={{ fontSize: '0.82rem', fontWeight: 600, color: active ? 'var(--z-text)' : 'var(--z-text-secondary)' }}>{f.label}</div>
                                                        <div style={{ fontSize: '0.62rem', color: 'var(--z-text-muted)' }}>{f.dims} · {f.platform}</div>
                                                    </div>
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>
                            </>
                        )}

                        {/* ── MODO BRIEF ────────────────────────────────── */}
                        {mode === 'brief' && (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                                {/* Upload Excel */}
                                <div>
                                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.6rem' }}>
                                        <div style={{ fontSize: '0.65rem', fontWeight: 800, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--z-text-muted)' }}>
                                            4 · Cuadro de materiales
                                        </div>
                                        <a
                                            href={`${API_BASE}/api/dco/template`}
                                            download="plantilla_dco.xlsx"
                                            style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.65rem', fontWeight: 700, color: '#16a34a', textDecoration: 'none', padding: '3px 10px', border: '1px solid #16a34a', borderRadius: 5, whiteSpace: 'nowrap', letterSpacing: '0.04em' }}
                                            title="Descargar plantilla Excel en blanco"
                                        >
                                            Descargar Plantilla
                                        </a>
                                    </div>
                                    {briefFile ? (
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', padding: '0.7rem 0.85rem', background: 'rgba(22,163,74,0.08)', borderRadius: 8, border: '2px solid #16a34a' }}>
                                            <Table2 size={18} color="#16a34a" />
                                            <span style={{ flex: 1, fontSize: '0.82rem', fontWeight: 600, color: 'var(--z-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{briefFile.name}</span>
                                            <button onClick={() => { setBriefFile(null); setBriefRows([]); setBriefError(''); setSelectedRows(new Set()); setRowFormatOverrides({}); setResults([]); setGenStatus('idle'); }}
                                                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--z-text-muted)', display: 'flex', padding: 0 }}>
                                                <X size={15} />
                                            </button>
                                        </div>
                                    ) : (
                                        <div
                                            onDragEnter={() => setIsDraggingBrief(true)}
                                            onDragLeave={() => setIsDraggingBrief(false)}
                                            onDragOver={e => e.preventDefault()}
                                            onDrop={onBriefDrop}
                                            onClick={() => briefInputRef.current?.click()}
                                            style={{ border: `2px dashed ${isDraggingBrief ? '#16a34a' : 'var(--z-border-strong)'}`, borderRadius: 10, padding: '2rem 1rem', textAlign: 'center', cursor: 'pointer', background: isDraggingBrief ? 'rgba(22,163,74,0.05)' : 'var(--z-bg)', transition: 'all 0.18s' }}>
                                            <Table2 size={28} color={isDraggingBrief ? '#16a34a' : 'var(--z-text-muted)'} style={{ margin: '0 auto 0.6rem' }} />
                                            <div style={{ fontSize: '0.9rem', fontWeight: 700, color: 'var(--z-text-secondary)', marginBottom: '0.25rem' }}>Sube el cuadro de materiales</div>
                                            <div style={{ fontSize: '0.72rem', color: 'var(--z-text-muted)' }}>Arrastra aquí o haz clic · .xlsx</div>
                                        </div>
                                    )}
                                    <input ref={briefInputRef} type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }} onChange={e => { const f = e.target.files?.[0]; if (f) handleBriefFile(f); }} />
                                </div>

                                {briefLoading && (
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.78rem', color: 'var(--z-text-muted)' }}>
                                        <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> Leyendo archivo...
                                    </div>
                                )}

                                {briefError && (
                                    <div style={{ fontSize: '0.75rem', color: '#ef4444', background: 'rgba(239,68,68,0.08)', borderRadius: 8, padding: '0.65rem 0.85rem', border: '1px solid rgba(239,68,68,0.25)' }}>
                                        {briefError}
                                    </div>
                                )}

                                {/* Selección de piezas */}
                                {briefRows.length > 0 && (
                                    <div>
                                        <div style={{ fontSize: '0.65rem', fontWeight: 800, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--z-text-muted)', marginBottom: '0.6rem' }}>
                                            5 · Elige qué piezas generar
                                        </div>

                                        {/* Seleccionar todo / ninguno */}
                                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.6rem' }}>
                                            <span style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--z-text)' }}>
                                                {selectedRows.size} de {briefRows.length} seleccionadas
                                            </span>
                                            <button onClick={toggleSelectAll}
                                                style={{ fontSize: '0.72rem', fontWeight: 700, color: ACCENT, background: 'none', border: 'none', cursor: 'pointer', padding: '0.2rem 0.5rem', borderRadius: 5, textDecoration: 'underline' }}>
                                                {selectedRows.size === briefRows.length ? 'Ninguna' : 'Todas'}
                                            </button>
                                        </div>

                                        {/* Cards de piezas — scroll propio */}
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', maxHeight: 360, overflowY: 'auto', paddingRight: 2 }}>
                                            {briefRows.map(row => {
                                                const selected = selectedRows.has(row.rowIndex);
                                                const currentFmt = rowFormatOverrides[row.rowIndex] || row.formatId;
                                                return (
                                                    <div key={row.rowIndex}
                                                        onClick={() => toggleRow(row.rowIndex)}
                                                        style={{ display: 'flex', alignItems: 'flex-start', gap: '0.65rem', padding: '0.75rem', borderRadius: 10, border: `2px solid ${selected ? ACCENT : 'var(--z-border)'}`, background: selected ? accentA(0.04) : 'var(--z-bg)', cursor: 'pointer', transition: 'all 0.15s' }}>

                                                        {/* Checkbox grande */}
                                                        <div style={{ width: 22, height: 22, borderRadius: 6, border: `2px solid ${selected ? ACCENT : 'var(--z-border-strong)'}`, background: selected ? ACCENT : 'transparent', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', marginTop: 1 }}>
                                                            {selected && <Check size={12} color="#fff" strokeWidth={3} />}
                                                        </div>

                                                        <div style={{ flex: 1, minWidth: 0 }}>
                                                            {/* Audiencia */}
                                                            <div style={{ fontWeight: 700, fontSize: '0.85rem', color: 'var(--z-text)', marginBottom: '0.4rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                                {row.audience || 'Sin audiencia'}
                                                            </div>

                                                            {/* Selector de formato */}
                                                            <select
                                                                value={currentFmt}
                                                                onClick={e => e.stopPropagation()}
                                                                onChange={e => { e.stopPropagation(); setRowFormatOverrides(prev => ({ ...prev, [row.rowIndex]: e.target.value })); }}
                                                                style={{ width: '100%', padding: '0.35rem 0.5rem', borderRadius: 6, border: '1px solid var(--z-border)', background: 'var(--z-surface)', color: 'var(--z-text)', fontSize: '0.72rem', cursor: 'pointer', outline: 'none', marginBottom: '0.4rem' }}>
                                                                {FORMATS.map(f => (
                                                                    <option key={f.id} value={f.id}>{f.label} · {f.dims}</option>
                                                                ))}
                                                            </select>

                                                            {/* Copy preview */}
                                                            <div style={{ fontSize: '0.66rem', color: 'var(--z-text-muted)', lineHeight: 1.4, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                                                                {row.copyPreview || '—'}
                                                            </div>
                                                        </div>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}

                        {/* ── MODO AUTOMÁTICO — subís el KV, el resto lo hace la IA ── */}
                        {mode === 'auto' && (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
                                <div style={{ fontSize: '0.65rem', fontWeight: 800, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--z-text-muted)' }}>
                                    2 · Generación automática
                                </div>
                                <div style={{ fontSize: '0.72rem', color: 'var(--z-text-muted)', lineHeight: 1.4 }}>
                                    Lee el copy y la categoría del KV, propone audiencias reales (con edad, características y perfil visual — vestuario/accesorios/entorno) y genera el copy adaptado para cada una. Después elegís cuáles convertir en imagen final.
                                </div>
                                <div>
                                    <div style={{ fontSize: '0.6rem', fontWeight: 700, color: 'var(--z-text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '0.3rem' }}>Contexto del negocio <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>(opcional, pero ayuda mucho)</span></div>
                                    <input type="text" value={autoBusinessContext} onChange={e => setAutoBusinessContext(e.target.value)}
                                        placeholder='ej. "Empresa de telecomunicaciones B2C"'
                                        style={{ width: '100%', padding: '0.5rem 0.6rem', borderRadius: 7, border: '1px solid var(--z-border)', background: 'var(--z-bg)', color: 'var(--z-text)', fontSize: '0.78rem', outline: 'none', boxSizing: 'border-box' }} />
                                </div>
                                <div>
                                    <div style={{ fontSize: '0.6rem', fontWeight: 700, color: 'var(--z-text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '0.3rem' }}>Cantidad de audiencias</div>
                                    <input type="number" min={2} max={10} value={autoAudienceCount}
                                        onChange={e => setAutoAudienceCount(Math.max(2, Math.min(10, parseInt(e.target.value) || 2)))}
                                        style={{ width: '100%', padding: '0.5rem 0.6rem', borderRadius: 7, border: '1px solid var(--z-border)', background: 'var(--z-bg)', color: 'var(--z-text)', fontSize: '0.78rem', outline: 'none', boxSizing: 'border-box' }} />
                                </div>
                                <button onClick={generateAutomatic} disabled={!kvFile || autoGenerating}
                                    style={{ width: '100%', padding: '0.85rem', borderRadius: 10, border: 'none', background: (!kvFile || autoGenerating) ? 'var(--z-border)' : `linear-gradient(135deg, ${ACCENT}, ${ACCENT_DARK})`, color: (!kvFile || autoGenerating) ? 'var(--z-text-muted)' : '#fff', fontWeight: 800, fontSize: '0.85rem', letterSpacing: '0.05em', textTransform: 'uppercase', cursor: (!kvFile || autoGenerating) ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.6rem' }}>
                                    {autoGenerating
                                        ? <><Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} /> Generando audiencias y copys...</>
                                        : !kvFile ? '← Sube el KV primero' : <><Sparkles size={16} /> Generar automáticamente</>}
                                </button>
                                {copyError && <div style={{ fontSize: '0.7rem', color: '#ef4444' }}>{copyError}</div>}
                            </div>
                        )}

                        {/* ── MODO COPYS IA ───────────────────────────── */}
                        {mode === 'copys' && (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                                {/* Fuente: Excel existente vs. formulario de audiencias directo */}
                                <div style={{ display: 'flex', gap: '0.5rem' }}>
                                    <button onClick={() => setCopySource('excel')}
                                        style={{ flex: 1, padding: '0.55rem', borderRadius: 8, border: `2px solid ${copySource === 'excel' ? ACCENT : 'var(--z-border)'}`, background: copySource === 'excel' ? accentA(0.06) : 'var(--z-bg)', cursor: 'pointer', fontSize: '0.72rem', fontWeight: 700, color: copySource === 'excel' ? ACCENT : 'var(--z-text-muted)' }}>
                                        Desde Excel
                                    </button>
                                    <button onClick={() => setCopySource('audiences')}
                                        style={{ flex: 1, padding: '0.55rem', borderRadius: 8, border: `2px solid ${copySource === 'audiences' ? ACCENT : 'var(--z-border)'}`, background: copySource === 'audiences' ? accentA(0.06) : 'var(--z-bg)', cursor: 'pointer', fontSize: '0.72rem', fontWeight: 700, color: copySource === 'audiences' ? ACCENT : 'var(--z-text-muted)' }}>
                                        Desde audiencias (sin Excel)
                                    </button>
                                </div>

                                {copySource === 'excel' && (
                                <div>
                                    <div style={{ fontSize: '0.65rem', fontWeight: 800, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--z-text-muted)', marginBottom: '0.6rem' }}>
                                        4 · Cuadro base (copys existentes)
                                    </div>
                                    {copyBriefFile ? (
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', padding: '0.7rem 0.85rem', background: accentA(0.06), borderRadius: 8, border: `2px solid ${ACCENT}` }}>
                                            <Table2 size={18} color={ACCENT} />
                                            <span style={{ flex: 1, fontSize: '0.8rem', fontWeight: 600, color: 'var(--z-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{copyBriefFile.name}</span>
                                            <button onClick={() => { setCopyBriefFile(null); setCopyPieces([]); setCopyIdentity(null); setCopyError(''); }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--z-text-muted)', display: 'flex', padding: 0 }}><X size={15} /></button>
                                        </div>
                                    ) : (
                                        <div onClick={() => copyBriefInputRef.current?.click()}
                                            style={{ border: '2px dashed var(--z-border-strong)', borderRadius: 10, padding: '2rem 1rem', textAlign: 'center', cursor: 'pointer', background: 'var(--z-bg)' }}>
                                            <Sparkles size={26} color={ACCENT} style={{ margin: '0 auto 0.6rem' }} />
                                            <div style={{ fontSize: '0.88rem', fontWeight: 700, color: 'var(--z-text-secondary)', marginBottom: '0.25rem' }}>Sube el cuadro de materiales base</div>
                                            <div style={{ fontSize: '0.7rem', color: 'var(--z-text-muted)' }}>De aquí aprendo la identidad de copy · .xlsx</div>
                                        </div>
                                    )}
                                    <input ref={copyBriefInputRef} type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }}
                                        onChange={e => { const f = e.target.files?.[0]; if (f) { setCopyBriefFile(f); setCopyPieces([]); setCopyIdentity(null); setCopyError(''); } }} />
                                </div>
                                )}

                                {copySource === 'audiences' && (
                                <div>
                                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.6rem', marginBottom: '0.6rem' }}>
                                        <div style={{ fontSize: '0.65rem', fontWeight: 800, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--z-text-muted)' }}>
                                            4 · Audiencias (definí quién aparece y a quién le hablás)
                                        </div>
                                        <button onClick={suggestAudiences} disabled={!kvFile || suggestingAudiences}
                                            title={!kvFile ? 'Subí primero el KV de referencia (paso 1)' : 'Lee el copy del KV y propone 3 audiencias automáticamente'}
                                            style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', padding: '0.4rem 0.7rem', borderRadius: 7, border: '1.5px solid #a78bfa', background: 'rgba(167,139,250,0.1)', cursor: (!kvFile || suggestingAudiences) ? 'not-allowed' : 'pointer', opacity: (!kvFile || suggestingAudiences) ? 0.5 : 1, fontSize: '0.68rem', fontWeight: 700, color: '#a78bfa', whiteSpace: 'nowrap' }}>
                                            <Sparkles size={13} />
                                            {suggestingAudiences ? 'Leyendo KV…' : 'Sugerir 3 con IA'}
                                        </button>
                                    </div>
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
                                        {audienceList.map((aud, i) => (
                                            <div key={i} style={{ padding: '0.7rem', borderRadius: 9, border: '2px solid var(--z-border)', background: 'var(--z-bg)', display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                                                <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
                                                    <input value={aud.name} onChange={e => setAudienceList(prev => prev.map((a, idx) => idx === i ? { ...a, name: e.target.value } : a))}
                                                        placeholder={`Audiencia ${i + 1} (ej: Profesionales jóvenes urbanos)`}
                                                        style={{ flex: 1, padding: '0.5rem 0.6rem', borderRadius: 6, border: '1px solid var(--z-border)', background: 'var(--z-surface)', color: 'var(--z-text)', fontSize: '0.78rem', fontWeight: 600, outline: 'none', boxSizing: 'border-box' }} />
                                                    {audienceList.length > 1 && (
                                                        <button onClick={() => setAudienceList(prev => prev.filter((_, idx) => idx !== i))}
                                                            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--z-text-muted)', display: 'flex', padding: '0.2rem' }}><X size={14} /></button>
                                                    )}
                                                </div>
                                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.4rem' }}>
                                                    <input value={aud.ageRange} onChange={e => setAudienceList(prev => prev.map((a, idx) => idx === i ? { ...a, ageRange: e.target.value } : a))}
                                                        placeholder="Edad (ej: 25-35 años)"
                                                        style={{ padding: '0.45rem 0.6rem', borderRadius: 6, border: '1px solid var(--z-border)', background: 'var(--z-surface)', color: 'var(--z-text)', fontSize: '0.72rem', outline: 'none', boxSizing: 'border-box' }} />
                                                    <input value={aud.interests} onChange={e => setAudienceList(prev => prev.map((a, idx) => idx === i ? { ...a, interests: e.target.value } : a))}
                                                        placeholder="Intereses (ej: fitness, familia)"
                                                        style={{ padding: '0.45rem 0.6rem', borderRadius: 6, border: '1px solid var(--z-border)', background: 'var(--z-surface)', color: 'var(--z-text)', fontSize: '0.72rem', outline: 'none', boxSizing: 'border-box' }} />
                                                </div>
                                                {/* Quién aparece — personaje consistente (reutiliza el sistema de personajes) */}
                                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem', alignItems: 'center' }}>
                                                    <span style={{ fontSize: '0.62rem', color: 'var(--z-text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginRight: '0.2rem' }}>Quién aparece:</span>
                                                    <button onClick={() => setAudienceList(prev => prev.map((a, idx) => idx === i ? { ...a, characterId: undefined } : a))}
                                                        style={{ padding: '0.3rem 0.6rem', borderRadius: 7, border: `1.5px solid ${!aud.characterId ? '#a78bfa' : 'var(--z-border)'}`, background: !aud.characterId ? 'rgba(167,139,250,0.1)' : 'var(--z-surface)', cursor: 'pointer', fontSize: '0.66rem', fontWeight: 600, color: !aud.characterId ? '#a78bfa' : 'var(--z-text-muted)' }}>
                                                        Genérico
                                                    </button>
                                                    {characters.map(ch => (
                                                        <button key={ch.id} onClick={() => setAudienceList(prev => prev.map((a, idx) => idx === i ? { ...a, characterId: ch.id } : a))}
                                                            style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', padding: '0.25rem 0.55rem 0.25rem 0.25rem', borderRadius: 7, border: `1.5px solid ${aud.characterId === ch.id ? '#a78bfa' : 'var(--z-border)'}`, background: aud.characterId === ch.id ? 'rgba(167,139,250,0.1)' : 'var(--z-surface)', cursor: 'pointer' }}>
                                                            <img src={ch.referencePhotoUrl} alt={ch.name} style={{ width: 18, height: 18, borderRadius: '50%', objectFit: 'cover' }} />
                                                            <span style={{ fontSize: '0.66rem', fontWeight: 600, color: aud.characterId === ch.id ? '#a78bfa' : 'var(--z-text)' }}>{ch.name}</span>
                                                        </button>
                                    ))}
                                                </div>
                                                {/* Perfil visual (vestuario/accesorios/entorno) — lo propone la IA, pero es
                                                    100% editable acá antes de generar copy/imagen; así se puede corregir si
                                                    no encaja con la marca. */}
                                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.4rem' }}>
                                                    <input value={aud.wardrobe || ''} onChange={e => setAudienceList(prev => prev.map((a, idx) => idx === i ? { ...a, wardrobe: e.target.value } : a))}
                                                        placeholder="Ropa del personaje"
                                                        style={{ padding: '0.4rem 0.55rem', borderRadius: 6, border: '1px solid var(--z-border)', background: 'var(--z-surface)', color: 'var(--z-text)', fontSize: '0.68rem', outline: 'none', boxSizing: 'border-box' }} />
                                                    <input value={aud.headwear || ''} onChange={e => setAudienceList(prev => prev.map((a, idx) => idx === i ? { ...a, headwear: e.target.value } : a))}
                                                        placeholder="Accesorio de cabeza"
                                                        style={{ padding: '0.4rem 0.55rem', borderRadius: 6, border: '1px solid var(--z-border)', background: 'var(--z-surface)', color: 'var(--z-text)', fontSize: '0.68rem', outline: 'none', boxSizing: 'border-box' }} />
                                                </div>
                                                <input value={aud.environment || ''} onChange={e => setAudienceList(prev => prev.map((a, idx) => idx === i ? { ...a, environment: e.target.value } : a))}
                                                    placeholder="Entorno/fondo de la escena"
                                                    style={{ padding: '0.4rem 0.55rem', borderRadius: 6, border: '1px solid var(--z-border)', background: 'var(--z-surface)', color: 'var(--z-text)', fontSize: '0.68rem', outline: 'none', boxSizing: 'border-box', width: '100%' }} />
                                            </div>
                                        ))}
                                        <button onClick={() => setAudienceList(prev => [...prev, { name: '', ageRange: '', interests: '' }])}
                                            style={{ padding: '0.5rem', borderRadius: 8, border: '2px dashed var(--z-border)', background: 'none', cursor: 'pointer', fontSize: '0.72rem', color: 'var(--z-text-muted)', fontWeight: 600 }}>
                                            + Agregar audiencia
                                        </button>
                                    </div>
                                </div>
                                )}

                                <div style={{ display: 'grid', gridTemplateColumns: copySource === 'excel' ? '1fr 1fr' : '1fr', gap: '0.6rem' }}>
                                    <div>
                                        <div style={{ fontSize: '0.6rem', fontWeight: 700, color: 'var(--z-text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '0.25rem' }}>Variantes / audiencia</div>
                                        <input type="number" min={1} max={6} value={variantsPerAudience}
                                            onChange={e => setVariantsPerAudience(Math.max(1, Math.min(6, parseInt(e.target.value) || 1)))}
                                            style={{ width: '100%', padding: '0.55rem 0.7rem', borderRadius: 7, border: '2px solid var(--z-border)', background: 'var(--z-bg)', color: 'var(--z-text)', fontSize: '0.85rem', fontWeight: 700, outline: 'none', boxSizing: 'border-box' }} />
                                    </div>
                                    {copySource === 'excel' && (
                                    <div>
                                        <div style={{ fontSize: '0.6rem', fontWeight: 700, color: 'var(--z-text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '0.25rem' }}>Audiencias nuevas</div>
                                        <input type="number" min={0} max={6} value={newAudiencesCount}
                                            onChange={e => setNewAudiencesCount(Math.max(0, Math.min(6, parseInt(e.target.value) || 0)))}
                                            style={{ width: '100%', padding: '0.55rem 0.7rem', borderRadius: 7, border: '2px solid var(--z-border)', background: 'var(--z-bg)', color: 'var(--z-text)', fontSize: '0.85rem', fontWeight: 700, outline: 'none', boxSizing: 'border-box' }} />
                                    </div>
                                    )}
                                </div>

                                <div>
                                    <div style={{ fontSize: '0.6rem', fontWeight: 700, color: 'var(--z-text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '0.25rem' }}>Instrucciones (opcional)</div>
                                    <textarea value={copyInstructions} onChange={e => setCopyInstructions(e.target.value)} rows={2}
                                        placeholder="Ej: enfócate en el lanzamiento de verano"
                                        style={{ width: '100%', padding: '0.55rem 0.7rem', borderRadius: 7, border: '2px solid var(--z-border)', background: 'var(--z-bg)', color: 'var(--z-text)', fontSize: '0.78rem', resize: 'vertical', outline: 'none', fontFamily: 'inherit', boxSizing: 'border-box' }} />
                                </div>

                                {(() => {
                                    const hasFilledAudience = audienceList.some(a => a.name.trim() || a.ageRange.trim() || a.interests.trim());
                                    const canGo = copySource === 'excel' ? !!copyBriefFile : hasFilledAudience;
                                    return (
                                        <button onClick={copySource === 'excel' ? generateCopies : generateCopiesFromAudiences} disabled={!canGo || copyLoading}
                                            style={{ width: '100%', padding: '0.8rem', borderRadius: 10, border: 'none', background: (!canGo || copyLoading) ? 'var(--z-border)' : `linear-gradient(135deg, ${ACCENT}, ${ACCENT_DARK})`, color: (!canGo || copyLoading) ? 'var(--z-text-muted)' : '#fff', fontWeight: 800, fontSize: '0.85rem', letterSpacing: '0.05em', textTransform: 'uppercase', cursor: (!canGo || copyLoading) ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem' }}>
                                            {copyLoading ? <><Loader2 size={15} style={{ animation: 'spin 1s linear infinite' }} /> Analizando y generando...</> : <><Sparkles size={15} /> Generar copys</>}
                                        </button>
                                    );
                                })()}
                                {copyError && <div style={{ fontSize: '0.72rem', color: '#ef4444', padding: '0.5rem 0.7rem', background: 'rgba(239,68,68,0.08)', borderRadius: 7, border: '1px solid rgba(239,68,68,0.3)' }}>{copyError}</div>}

                                {copyIdentity && (
                                    <div style={{ padding: '0.75rem 0.85rem', background: 'var(--z-bg)', borderRadius: 9, border: '1px solid var(--z-border)' }}>
                                        <div style={{ fontSize: '0.6rem', fontWeight: 800, letterSpacing: '0.1em', textTransform: 'uppercase', color: ACCENT, marginBottom: '0.5rem' }}>Identidad de copy detectada</div>
                                        {copyIdentity.tono && <div style={{ fontSize: '0.7rem', color: 'var(--z-text)', marginBottom: '0.3rem' }}><b>Tono:</b> {copyIdentity.tono}</div>}
                                        {copyIdentity.formula && <div style={{ fontSize: '0.7rem', color: 'var(--z-text)', marginBottom: '0.3rem' }}><b>Fórmula:</b> {copyIdentity.formula}</div>}
                                        {copyIdentity.resumen && <div style={{ fontSize: '0.68rem', color: 'var(--z-text-secondary)', lineHeight: 1.4, marginBottom: '0.3rem' }}>{copyIdentity.resumen}</div>}
                                        {Array.isArray(copyIdentity.palabras_prohibidas) && copyIdentity.palabras_prohibidas.length > 0 && (
                                            <div style={{ fontSize: '0.64rem', color: '#ef4444' }}><b>Prohibidas:</b> {copyIdentity.palabras_prohibidas.join(', ')}</div>
                                        )}
                                    </div>
                                )}
                            </div>
                        )}

                        {/* ── MODO CARRUSEL ─────────────────────────────── */}
                        {mode === 'carousel' && (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                                <div>
                                    <div style={{ fontSize: '0.65rem', fontWeight: 800, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--z-text-muted)', marginBottom: '0.5rem' }}>4 · Historia a contar</div>
                                    <textarea value={carouselNarrative} onChange={e => setCarouselNarrative(e.target.value)} rows={4}
                                        placeholder="Ej: El protagonista empieza el día con un problema cotidiano, descubre el producto en su rutina, y termina el día con una solución satisfactoria."
                                        style={{ width: '100%', padding: '0.6rem 0.75rem', borderRadius: 8, border: '2px solid var(--z-border)', background: 'var(--z-bg)', color: 'var(--z-text)', fontSize: '0.8rem', resize: 'vertical', outline: 'none', fontFamily: 'inherit', lineHeight: 1.4, boxSizing: 'border-box' }} />
                                    {!characterId && <div style={{ fontSize: '0.62rem', color: '#f59e0b', marginTop: '0.4rem' }}>⚠ Elegí un personaje arriba para que la historia mantenga la misma persona en todos los slides.</div>}
                                </div>
                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.6rem' }}>
                                    <div>
                                        <div style={{ fontSize: '0.6rem', fontWeight: 700, color: 'var(--z-text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '0.25rem' }}>Formato</div>
                                        <select value={carouselFormat} onChange={e => setCarouselFormat(e.target.value as '1:1' | '4:5')}
                                            style={{ width: '100%', padding: '0.55rem 0.7rem', borderRadius: 7, border: '2px solid var(--z-border)', background: 'var(--z-bg)', color: 'var(--z-text)', fontSize: '0.8rem', fontWeight: 700, outline: 'none', boxSizing: 'border-box' }}>
                                            <option value="1:1">Cuadrado — 1080×1080</option>
                                            <option value="4:5">Vertical — 1080×1350</option>
                                        </select>
                                    </div>
                                    <div>
                                        <div style={{ fontSize: '0.6rem', fontWeight: 700, color: 'var(--z-text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '0.25rem' }}>Slides</div>
                                        <input type="number" min={3} max={6} value={carouselSlideCount}
                                            onChange={e => setCarouselSlideCount(Math.max(3, Math.min(6, parseInt(e.target.value) || 4)))}
                                            style={{ width: '100%', padding: '0.55rem 0.7rem', borderRadius: 7, border: '2px solid var(--z-border)', background: 'var(--z-bg)', color: 'var(--z-text)', fontSize: '0.85rem', fontWeight: 700, outline: 'none', boxSizing: 'border-box' }} />
                                    </div>
                                </div>
                                <button onClick={generateCarousel} disabled={!kvFile || !carouselNarrative.trim() || carouselStatus === 'generating'}
                                    style={{ width: '100%', padding: '0.8rem', borderRadius: 10, border: 'none', background: (!kvFile || !carouselNarrative.trim() || carouselStatus === 'generating') ? 'var(--z-border)' : 'linear-gradient(135deg, #a78bfa, #7c3aed)', color: (!kvFile || !carouselNarrative.trim() || carouselStatus === 'generating') ? 'var(--z-text-muted)' : '#fff', fontWeight: 800, fontSize: '0.85rem', letterSpacing: '0.05em', textTransform: 'uppercase', cursor: (!kvFile || !carouselNarrative.trim() || carouselStatus === 'generating') ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem' }}>
                                    {carouselStatus === 'generating' ? <><Loader2 size={15} style={{ animation: 'spin 1s linear infinite' }} /> Generando carrusel...</> : <>🎠 Generar Carrusel</>}
                                </button>
                                {carouselError && <div style={{ fontSize: '0.72rem', color: '#ef4444', padding: '0.5rem 0.7rem', background: 'rgba(239,68,68,0.08)', borderRadius: 7, border: '1px solid rgba(239,68,68,0.3)' }}>{carouselError}</div>}
                            </div>
                        )}
                    </div>

                </div>

                {/* ── Panel derecho: galería ──────────────────────────────── */}
                <div style={{ overflowY: 'auto', padding: '1.25rem', background: 'var(--z-bg)' }}>
                    {mode === 'carousel' ? (
                        carouselBeats.length === 0 ? (
                            <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '1.25rem', color: 'var(--z-text-muted)', minHeight: 400 }}>
                                <div style={{ fontSize: '2.5rem' }}>🎠</div>
                                <div style={{ fontSize: '0.8rem', textAlign: 'center' }}>Sube un KV, elegí un personaje (opcional) y contá la historia</div>
                            </div>
                        ) : (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.9rem', maxWidth: 480, margin: '0 auto' }}>
                                {carouselBeats.map((beat, i) => {
                                    const slide = carouselSlides[i];
                                    return (
                                        <div key={i} style={{ border: '1px solid var(--z-border)', borderRadius: 10, overflow: 'hidden', background: 'var(--z-bg-secondary)' }}>
                                            <div style={{ padding: '0.5rem 0.7rem', fontSize: '0.68rem', fontWeight: 700, color: 'var(--z-text-muted)', borderBottom: '1px solid var(--z-border)' }}>
                                                Slide {i + 1}/{carouselBeats.length} {beat.copy.headline ? `— ${beat.copy.headline}` : ''}
                                            </div>
                                            <div style={{ minHeight: 120, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                                {(!slide || slide.status === 'generating') && <div style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.5rem', color: 'var(--z-text-muted)', fontSize: '0.72rem' }}><Loader2 size={20} style={{ animation: 'spin 1s linear infinite', color: '#a78bfa' }} />Generando...</div>}
                                                {slide?.status === 'done' && <img src={`data:${slide.mimeType};base64,${slide.imageBase64}`} alt={`Slide ${i + 1}`} style={{ width: '100%', display: 'block' }} />}
                                                {slide?.status === 'error' && <div style={{ padding: '1.5rem', color: '#ef4444', fontSize: '0.72rem' }}><AlertCircle size={18} /> Error en este slide</div>}
                                            </div>
                                            {slide?.status === 'done' && (
                                                <div style={{ padding: '0.35rem 0.7rem', fontSize: '0.6rem', color: slide.score >= 85 ? '#4ade80' : '#f59e0b', borderTop: '1px solid var(--z-border)' }}>QA {slide.score}/100</div>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        )
                    ) : (mode === 'copys' || mode === 'auto') ? (
                        copyPieces.length === 0 ? (
                            <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '1.25rem', color: 'var(--z-text-muted)', minHeight: 400 }}>
                                <div style={{ width: 80, height: 80, borderRadius: 20, background: 'var(--z-surface)', border: '2px dashed var(--z-border)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                    <Sparkles size={32} color="var(--z-border-strong)" />
                                </div>
                                <div style={{ textAlign: 'center' }}>
                                    <div style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--z-text-secondary)', marginBottom: '0.35rem' }}>Los copys generados aparecerán aquí</div>
                                    <div style={{ fontSize: '0.78rem', color: 'var(--z-text-muted)' }}>{mode === 'auto' ? 'Sube el KV y presiona "Generar automáticamente"' : 'Sube el cuadro base y presiona "Generar copys"'}</div>
                                </div>
                            </div>
                        ) : (
                            <div>
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
                                    <div style={{ fontSize: '0.85rem', fontWeight: 800, color: 'var(--z-text)' }}>{copyPieces.length} copys generados</div>
                                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                                        <button onClick={downloadCuadro} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', padding: '0.5rem 1rem', background: '#16a34a', color: '#fff', border: 'none', borderRadius: 7, fontSize: '0.72rem', fontWeight: 700, cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '0.04em' }}><Download size={13} /> Descargar cuadro</button>
                                        <button onClick={sendCopiesToDCO} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', padding: '0.5rem 1rem', background: ACCENT, color: '#fff', border: 'none', borderRadius: 7, fontSize: '0.72rem', fontWeight: 700, cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '0.04em' }}><Sparkles size={13} /> Enviar al DCO</button>
                                    </div>
                                </div>
                                {/* ── Recrear con IA (foto real vía outpainting) — formatos que soporta GPT-image ── */}
                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '1rem', padding: '0.6rem 0.75rem', borderRadius: 8, background: 'var(--z-bg)', border: '1px dashed var(--z-border)' }}>
                                    <span style={{ fontSize: '0.62rem', fontWeight: 700, color: 'var(--z-text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Recrear con IA — formatos:</span>
                                    {RECREATE_FORMAT_OPTIONS.map(fid => {
                                        const f = FORMATS.find(x => x.id === fid);
                                        const active = recreateFormatIds.includes(fid);
                                        return (
                                            <button key={fid} onClick={() => setRecreateFormatIds(prev => active ? prev.filter(x => x !== fid) : [...prev, fid])}
                                                style={{ padding: '0.3rem 0.6rem', borderRadius: 7, border: `1.5px solid ${active ? '#a78bfa' : 'var(--z-border)'}`, background: active ? 'rgba(167,139,250,0.1)' : 'var(--z-surface)', cursor: 'pointer', fontSize: '0.66rem', fontWeight: 600, color: active ? '#a78bfa' : 'var(--z-text-muted)' }}>
                                                {f?.label || fid}
                                            </button>
                                        );
                                    })}
                                </div>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.7rem' }}>
                                    {copyPieces.map((p, i) => (
                                        <div key={i} style={{ borderRadius: 10, border: '1px solid var(--z-border)', background: 'var(--z-surface)', padding: '0.85rem' }}>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.6rem', flexWrap: 'wrap' }}>
                                                <span style={{ fontSize: '0.78rem', fontWeight: 800, color: 'var(--z-text)' }}>{p.audiencia || '—'}</span>
                                                {p.variante && <span style={{ fontSize: '0.6rem', fontWeight: 700, color: ACCENT, background: accentA(0.1), borderRadius: 4, padding: '1px 7px' }}>{p.variante}</span>}
                                                {p.nuevaAudiencia && <span style={{ fontSize: '0.58rem', fontWeight: 700, color: '#16a34a', background: 'rgba(22,163,74,0.12)', border: '1px solid #16a34a', borderRadius: 4, padding: '1px 6px' }}>AUDIENCIA NUEVA</span>}
                                                {p.chip && <span style={{ fontSize: '0.6rem', fontWeight: 700, color: '#b45309', background: 'rgba(255,215,0,0.15)', borderRadius: 4, padding: '1px 7px' }}>{p.chip}</span>}
                                            </div>
                                            {([['copy_principal', 'Copy principal'], ['desarrollo', 'Desarrollo'], ['cierre', 'Cierre']] as const).map(([field, label]) => (
                                                <div key={field} style={{ marginBottom: '0.45rem' }}>
                                                    <div style={{ fontSize: '0.55rem', fontWeight: 700, color: 'var(--z-text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '0.15rem' }}>{label}</div>
                                                    <textarea value={p[field] || ''} onChange={e => updateCopyPiece(i, field, e.target.value)} rows={field === 'desarrollo' ? 2 : 1}
                                                        style={{ width: '100%', padding: '0.4rem 0.55rem', borderRadius: 6, border: '1px solid var(--z-border)', background: 'var(--z-bg)', color: 'var(--z-text)', fontSize: '0.72rem', resize: 'vertical', outline: 'none', fontFamily: 'inherit', boxSizing: 'border-box', fontWeight: field === 'copy_principal' ? 700 : 400 }} />
                                                </div>
                                            ))}
                                            {/* Perfil visual del personaje para esta pieza — editable acá mismo antes de
                                                recrear la imagen, por si la IA propuso algo que no encaja (ej. un accesorio
                                                que no corresponde a esta marca). */}
                                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.35rem', marginBottom: '0.45rem' }}>
                                                <div>
                                                    <div style={{ fontSize: '0.55rem', fontWeight: 700, color: 'var(--z-text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '0.15rem' }}>Ropa del personaje</div>
                                                    <input value={p.wardrobe || ''} onChange={e => updateCopyPiece(i, 'wardrobe', e.target.value)}
                                                        style={{ width: '100%', padding: '0.35rem 0.5rem', borderRadius: 6, border: '1px solid var(--z-border)', background: 'var(--z-bg)', color: 'var(--z-text)', fontSize: '0.66rem', outline: 'none', boxSizing: 'border-box' }} />
                                                </div>
                                                <div>
                                                    <div style={{ fontSize: '0.55rem', fontWeight: 700, color: 'var(--z-text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '0.15rem' }}>Accesorio</div>
                                                    <input value={p.headwear || ''} onChange={e => updateCopyPiece(i, 'headwear', e.target.value)}
                                                        style={{ width: '100%', padding: '0.35rem 0.5rem', borderRadius: 6, border: '1px solid var(--z-border)', background: 'var(--z-bg)', color: 'var(--z-text)', fontSize: '0.66rem', outline: 'none', boxSizing: 'border-box' }} />
                                                </div>
                                            </div>
                                            <div style={{ marginBottom: '0.6rem' }}>
                                                <div style={{ fontSize: '0.55rem', fontWeight: 700, color: 'var(--z-text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '0.15rem' }}>Entorno/fondo</div>
                                                <input value={p.environment || ''} onChange={e => updateCopyPiece(i, 'environment', e.target.value)}
                                                    style={{ width: '100%', padding: '0.35rem 0.5rem', borderRadius: 6, border: '1px solid var(--z-border)', background: 'var(--z-bg)', color: 'var(--z-text)', fontSize: '0.66rem', outline: 'none', boxSizing: 'border-box' }} />
                                            </div>
                                            {/* Modo creativo — libera TAMBIÉN el ángulo/escena/acción (no solo vestuario/
                                                entorno). Apagado por defecto: algunas marcas necesitan conservar un
                                                encuadre específico. */}
                                            <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.6rem', cursor: 'pointer', fontSize: '0.66rem', color: 'var(--z-text-muted)' }}>
                                                <input type="checkbox" checked={!!p.varyScene} onChange={e => updateCopyPiece(i, 'varyScene', e.target.checked)} />
                                                🎨 Variar escena y ángulo (modo creativo) — para esta audiencia, proponer un encuadre/situación nuevos en vez de mantener el mismo que el KV
                                            </label>
                                            <button onClick={() => recreateWithAI(i)} disabled={!kvFile || recreating[i] || recreateFormatIds.length === 0}
                                                style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', padding: '0.4rem 0.8rem', background: 'none', border: '1.5px solid #a78bfa', color: '#a78bfa', borderRadius: 7, fontSize: '0.68rem', fontWeight: 700, cursor: (!kvFile || recreating[i]) ? 'not-allowed' : 'pointer', opacity: (!kvFile || recreating[i]) ? 0.5 : 1, marginTop: '0.2rem' }}>
                                                {recreating[i] ? <><Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> Recreando...</> : <>🪄 Recrear con foto real (IA)</>}
                                            </button>
                                            {recreateResults[i] && Object.keys(recreateResults[i]).length > 0 && (
                                                <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap', marginTop: '0.6rem' }}>
                                                    {Object.entries(recreateResults[i]).map(([fid, r]) => (
                                                        <div key={fid} style={{ width: 140, borderRadius: 8, overflow: 'hidden', border: '1px solid var(--z-border)', background: 'var(--z-bg)' }}>
                                                            <div style={{ minHeight: 90, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                                                {r.status === 'generating' && <Loader2 size={18} style={{ animation: 'spin 1s linear infinite', color: '#a78bfa' }} />}
                                                                {r.status === 'error' && <AlertCircle size={16} color="#ef4444" />}
                                                                {r.status === 'done' && r.imageBase64 && <img src={`data:${r.mimeType};base64,${r.imageBase64}`} alt={fid} style={{ width: '100%', display: 'block' }} />}
                                                            </div>
                                                            <div style={{ padding: '0.3rem 0.4rem', fontSize: '0.58rem', color: 'var(--z-text-muted)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.3rem' }}>
                                                                <span>{FORMATS.find(x => x.id === fid)?.label || fid}</span>
                                                                {r.status === 'done' && r.imageBase64 && (
                                                                    <a href={`data:${r.mimeType};base64,${r.imageBase64}`} download={`recreate_${fid}_${i}.png`} style={{ color: '#a78bfa' }}><Download size={11} /></a>
                                                                )}
                                                            </div>
                                                        </div>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )
                    ) : results.length === 0 ? (
                        <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '1.25rem', color: 'var(--z-text-muted)', minHeight: 400 }}>
                            <div style={{ width: 80, height: 80, borderRadius: 20, background: 'var(--z-surface)', border: '2px dashed var(--z-border)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                <ImageIcon size={32} color="var(--z-border-strong)" />
                            </div>
                            <div style={{ textAlign: 'center' }}>
                                <div style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--z-text-secondary)', marginBottom: '0.35rem' }}>Los creativos aparecerán aquí</div>
                                <div style={{ fontSize: '0.78rem', color: 'var(--z-text-muted)' }}>
                                    {mode === 'manual' ? 'Sube un KV, elige formatos y presiona Generar' : 'Sube un KV, importa el brief y presiona Generar'}
                                </div>
                            </div>
                        </div>
                    ) : (
                        <div style={{ columns: '280px', columnGap: '1rem' }}>
                            {results.map(item => (
                                <div key={item.taskId} style={{ breakInside: 'avoid', marginBottom: '1rem', borderRadius: 12, border: '1px solid var(--z-border)', overflow: 'hidden', background: 'var(--z-surface)' }}>
                                    {/* Card header */}
                                    <div style={{ padding: '0.65rem 0.85rem', borderBottom: '1px solid var(--z-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem' }}>
                                        <div style={{ minWidth: 0 }}>
                                            <div style={{ fontSize: '0.78rem', fontWeight: 700, color: 'var(--z-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.label}</div>
                                            {item.width > 0 && (
                                                <div style={{ fontSize: '0.62rem', color: 'var(--z-text-muted)' }}>{item.width}×{item.height} px · {item.platform}</div>
                                            )}
                                        </div>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', flexWrap: 'wrap', justifyContent: 'flex-end', maxWidth: '60%' }}>
                                            {item.status === 'waiting'    && <div style={{ fontSize: '0.62rem', color: 'var(--z-text-muted)', background: 'var(--z-bg-secondary)', borderRadius: 4, padding: '2px 8px' }}>En cola</div>}
                                            {item.status === 'generating' && <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', fontSize: '0.62rem', color: '#f59e0b' }}><Loader2 size={10} style={{ animation: 'spin 1s linear infinite' }} /> Generando</div>}
                                            {item.status === 'qa_check'  && <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', fontSize: '0.62rem', color: '#a78bfa' }}><Loader2 size={10} style={{ animation: 'spin 1s linear infinite' }} /> QA · Reintentando</div>}
                                            {item.status === 'done' && (
                                                <>
                                                    <CheckCircle2 size={14} color="#22c55e" />
                                                    {item.qaAttempts === 2 && <div title="QA detectó errores y se reintentó" style={{ fontSize: '0.58rem', color: '#a78bfa', background: 'rgba(167,139,250,0.12)', border: '1px solid rgba(167,139,250,0.3)', borderRadius: 4, padding: '1px 6px', whiteSpace: 'nowrap' }}>QA ↺</div>}
                                                    <button onClick={() => downloadImage(item)}
                                                        style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', padding: '3px 10px', background: ACCENT, color: '#fff', border: 'none', borderRadius: 5, fontSize: '0.65rem', fontWeight: 700, cursor: 'pointer' }}>
                                                        <Download size={10} /> JPG
                                                    </button>
                                                    {/* Re-generar en otro formato */}
                                                    <div style={{ position: 'relative' }}>
                                                        <button
                                                            onClick={() => setRegenPicker(prev => prev === item.taskId ? null : item.taskId)}
                                                            title="Re-generar en otro formato"
                                                            style={{ padding: '3px 7px', background: 'none', border: '1px solid var(--z-border)', borderRadius: 5, fontSize: '0.65rem', color: 'var(--z-text)', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                                                            ↺ Formato
                                                        </button>
                                                        {regenPicker === item.taskId && (
                                                            <div style={{ position: 'absolute', top: '100%', right: 0, zIndex: 100, marginTop: 4, background: 'var(--z-surface-elevated)', border: '1px solid var(--z-border)', borderRadius: 8, padding: '0.4rem', minWidth: 160, boxShadow: '0 8px 24px rgba(0,0,0,0.4)' }}>
                                                                <div style={{ fontSize: '0.6rem', color: 'var(--z-text-muted)', marginBottom: '0.3rem', paddingLeft: 4, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Mismo copy · nuevo formato</div>
                                                                {FORMATS.map(f => (
                                                                    <button key={f.id} onClick={() => regenerateInFormat(item, f.id)}
                                                                        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', padding: '4px 8px', background: f.id === item.format ? accentA(0.12) : 'none', border: 'none', borderRadius: 5, fontSize: '0.65rem', color: 'var(--z-text)', cursor: 'pointer', gap: '0.5rem', textAlign: 'left' }}>
                                                                        <span>{f.label}</span>
                                                                        <span style={{ color: 'var(--z-text-muted)', fontSize: '0.58rem' }}>{f.dims}</span>
                                                                    </button>
                                                                ))}
                                                            </div>
                                                        )}
                                                    </div>
                                                    {/* Ver copy */}
                                                    <button
                                                        onClick={() => setShowCopy(prev => ({ ...prev, [item.taskId]: !prev[item.taskId] }))}
                                                        title="Ver copy usado"
                                                        style={{ padding: '3px 7px', background: showCopy[item.taskId] ? accentA(0.1) : 'none', border: '1px solid var(--z-border)', borderRadius: 5, fontSize: '0.65rem', color: 'var(--z-text)', cursor: 'pointer' }}>
                                                        {showCopy[item.taskId] ? '▲ Copy' : '▼ Copy'}
                                                    </button>
                                                    {item.status === 'done' && (
                                                        <button
                                                            onClick={async () => {
                                                                if (item.gifBase64) { setShowGif(prev => ({ ...prev, [item.taskId]: !prev[item.taskId] })); return; }
                                                                setGifLoading(prev => ({ ...prev, [item.taskId]: true }));
                                                                try {
                                                                    // El logo real (si se subió) viaja para componerse determinísticamente
                                                                    // en el frame de cierre — nunca se le pide a la IA que lo dibuje.
                                                                    const logoDataUrl = logoPreview && logoPreview.startsWith('data:') ? logoPreview : '';
                                                                    const logoB64 = logoDataUrl ? logoDataUrl.slice(logoDataUrl.indexOf(',') + 1) : undefined;
                                                                    const logoMime = logoDataUrl ? (logoDataUrl.match(/^data:([^;]+);/)?.[1] || 'image/png') : undefined;
                                                                    const res = await fetch(`${API_BASE}/api/dco/generate-gif`, { method: 'POST', headers: authedHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ imageBase64: item.imageBase64, mimeType: item.mimeType || 'image/jpeg', formatId: item.format, width: item.width, height: item.height, headline: item.copyData?.headline || '', cta: item.copyData?.cta || '', logoBase64: logoB64, logoMime }) });
                                                                    const data = await res.json() as any;
                                                                    if (data.gifBase64) { setResults(prev => prev.map(r => r.taskId === item.taskId ? { ...r, gifBase64: data.gifBase64 } : r)); setShowGif(prev => ({ ...prev, [item.taskId]: true })); }
                                                                } catch (e) { console.warn('GIF error', e); } finally { setGifLoading(prev => ({ ...prev, [item.taskId]: false })); }
                                                            }}
                                                            title="Generar GIF animado"
                                                            style={{ padding: '3px 7px', background: showGif[item.taskId] ? 'rgba(16,185,129,0.15)' : 'none', border: `1px solid ${showGif[item.taskId] ? '#10b981' : 'var(--z-border)'}`, borderRadius: 5, fontSize: '0.65rem', color: gifLoading[item.taskId] ? '#f59e0b' : showGif[item.taskId] ? '#10b981' : 'var(--z-text)', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                                                            {gifLoading[item.taskId] ? '⏳ GIF' : item.gifBase64 ? 'GIF ▲' : 'GIF'}
                                                        </button>
                                                    )}
                                                    {item.videoPrompt && (
                                                        <button
                                                            onClick={() => setShowVideoPrompt(prev => ({ ...prev, [item.taskId]: !prev[item.taskId] }))}
                                                            title="Ver prompt de video 15s"
                                                            style={{ padding: '3px 7px', background: showVideoPrompt[item.taskId] ? 'rgba(139,92,246,0.15)' : 'none', border: `1px solid ${showVideoPrompt[item.taskId] ? '#8b5cf6' : 'var(--z-border)'}`, borderRadius: 5, fontSize: '0.65rem', color: showVideoPrompt[item.taskId] ? '#8b5cf6' : 'var(--z-text)', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                                                            🎬 Video
                                                        </button>
                                                    )}
                                                    {!item.feedbackSent && !item.feedback && (
                                                        <>
                                                            <button onClick={() => sendFeedback(item, 'good')}
                                                                title="Buena pieza"
                                                                style={{ background: 'none', border: '1px solid #22c55e', borderRadius: 5, padding: '2px 6px', cursor: 'pointer', fontSize: '0.7rem' }}>👍</button>
                                                            <button onClick={() => setResults(prev => prev.map(r => r.taskId === item.taskId ? { ...r, feedback: 'bad' } : r))}
                                                                title="Reportar error"
                                                                style={{ background: 'none', border: '1px solid #ef4444', borderRadius: 5, padding: '2px 6px', cursor: 'pointer', fontSize: '0.7rem' }}>👎</button>
                                                        </>
                                                    )}
                                                    {item.feedbackSent && <span style={{ fontSize: '0.62rem', color: '#22c55e' }}>✓ Gracias</span>}
                                                </>
                                            )}
                                            {item.status === 'error' && <AlertCircle size={14} color="#ef4444" />}
                                        </div>
                                    </div>

                                    {/* Ajuste quirúrgico — el usuario describe qué corregir y se regenera sobre la imagen existente */}
                                    {item.status === 'done' && item.feedback === 'bad' && !item.feedbackSent && (
                                        <div style={{ padding: '0.5rem 0.85rem', borderBottom: '1px solid var(--z-border)', background: 'rgba(239,68,68,0.05)' }}>
                                            <p style={{ fontSize: '0.65rem', color: '#ef4444', marginBottom: '0.15rem', fontWeight: 700 }}>✏️ ¿Qué corregimos?</p>
                                            <p style={{ fontSize: '0.58rem', color: 'var(--z-text-muted)', marginBottom: '0.35rem' }}>Describe el ajuste — el sistema corrige solo eso sin cambiar el resto de la imagen.</p>
                                            <textarea
                                                value={feedbackComments[item.taskId] || ''}
                                                onChange={e => setFeedbackComments(prev => ({ ...prev, [item.taskId]: e.target.value }))}
                                                placeholder="Ej: el titular está en negro, cámbialo a blanco · la silueta está sobre un elemento equivocado, muévela · la zona izquierda quedó vacía, agrega el copy ahí..."
                                                rows={3}
                                                style={{ width: '100%', padding: '0.35rem 0.5rem', background: 'var(--z-bg)', border: '1px solid #ef4444', borderRadius: 5, color: 'var(--z-text)', fontSize: '0.65rem', resize: 'vertical', outline: 'none', boxSizing: 'border-box' }}
                                            />
                                            <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.35rem' }}>
                                                <button
                                                    onClick={() => {
                                                        const correction = feedbackComments[item.taskId] || '';
                                                        if (!correction.trim()) { alert('Escribe qué corregir antes de continuar'); return; }
                                                        retouchItem(item, correction);
                                                        setFeedbackComments(prev => ({ ...prev, [item.taskId]: '' }));
                                                    }}
                                                    style={{ flex: 1, padding: '5px 8px', background: '#ef4444', color: '#fff', border: 'none', borderRadius: 5, fontSize: '0.65rem', fontWeight: 700, cursor: 'pointer' }}>
                                                    🔧 Regenerar con ajuste
                                                </button>
                                                <button
                                                    onClick={() => setResults(prev => prev.map(r => r.taskId === item.taskId ? { ...r, feedback: null } : r))}
                                                    style={{ padding: '5px 8px', background: 'none', border: '1px solid var(--z-border)', borderRadius: 5, fontSize: '0.65rem', color: 'var(--z-text-muted)', cursor: 'pointer' }}>
                                                    Cancelar
                                                </button>
                                            </div>
                                        </div>
                                    )}

                                    {/* Panel de copy expandible */}
                                    {item.status === 'done' && showCopy[item.taskId] && item.copyData && (
                                        <div style={{ padding: '0.6rem 0.85rem', borderBottom: '1px solid var(--z-border)', background: 'var(--z-bg-secondary)', display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                                            {[
                                                { label: 'Titular', value: item.copyData.headline },
                                                { label: 'Subtítulo', value: item.copyData.subhead },
                                                { label: 'Pill badge', value: item.copyData.chip },
                                                { label: 'Body', value: item.copyData.body },
                                                { label: 'CTA', value: item.copyData.cta },
                                            ].filter(f => f.value).map(f => (
                                                <div key={f.label}>
                                                    <span style={{ fontSize: '0.58rem', color: 'var(--z-text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{f.label} </span>
                                                    <span style={{ fontSize: '0.65rem', color: f.label === 'Pill badge' ? '#FFD700' : 'var(--z-text)', fontWeight: f.label === 'Titular' ? 700 : 400 }}>{f.value}</span>
                                                </div>
                                            ))}
                                            {item.sceneDesc && (
                                                <div>
                                                    <span style={{ fontSize: '0.58rem', color: 'var(--z-text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Escena </span>
                                                    <span style={{ fontSize: '0.62rem', color: 'var(--z-text-muted)', fontStyle: 'italic' }}>{item.sceneDesc.slice(0, 120)}{item.sceneDesc.length > 120 ? '…' : ''}</span>
                                                </div>
                                            )}
                                        </div>
                                    )}

                                    {/* Panel GIF animado */}
                                    {item.status === 'done' && showGif[item.taskId] && item.gifBase64 && (
                                        <div style={{ padding: '0.6rem 0.85rem', borderBottom: '1px solid var(--z-border)', background: 'rgba(16,185,129,0.05)', display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                                                <span style={{ fontSize: '0.58rem', fontWeight: 800, color: '#10b981', textTransform: 'uppercase', letterSpacing: '0.08em' }}>GIF ANIMADO — 3 frames × 400ms</span>
                                                <a
                                                    href={`data:image/gif;base64,${item.gifBase64}`}
                                                    download={`${item.taskId}.gif`}
                                                    style={{ padding: '2px 8px', background: '#10b981', color: '#fff', borderRadius: 4, fontSize: '0.56rem', fontWeight: 700, textDecoration: 'none' }}>
                                                    Descargar GIF
                                                </a>
                                            </div>
                                            <img
                                                src={`data:image/gif;base64,${item.gifBase64}`}
                                                alt="GIF animado"
                                                style={{ width: '100%', borderRadius: 4, imageRendering: 'auto' }}
                                            />
                                        </div>
                                    )}

                                    {/* Panel de prompt de video expandible — structured 3-segment view */}
                                    {item.status === 'done' && showVideoPrompt[item.taskId] && item.videoPrompt && (() => {
                                        const vp = item.videoPrompt!;
                                        // Robust regex: matches # ━━━ CLIP 1, ━━━ CLIP 1, or plain CLIP 1 headers
                                        const seg1 = vp.match(/(?:^|\n)[#\s]*(?:━+\s*)?CLIP\s+1[^\n]*\n([\s\S]*?)(?=(?:^|\n)[#\s]*(?:━+\s*)?CLIP\s+2)/m)?.[1]?.trim() || '';
                                        const seg2 = vp.match(/(?:^|\n)[#\s]*(?:━+\s*)?CLIP\s+2[^\n]*\n([\s\S]*?)(?=(?:^|\n)[#\s]*(?:━+\s*)?CLIP\s+3)/m)?.[1]?.trim() || '';
                                        const seg3 = vp.match(/(?:^|\n)[#\s]*(?:━+\s*)?CLIP\s+3[^\n]*\n([\s\S]*?)(?=(?:^|\n)[#\s]*(?:━+\s*)?(?:CLIP\s+4|SPECS|PROMPTS|VEO3|REGLA)|$)/m)?.[1]?.trim() || '';
                                        const voMatches = [...vp.matchAll(/^\**VO\**[^:\n]*:\s*[*_]*"([^"]+)"[*_]*/gm)];
                                        const [vo1, vo2, vo3] = [voMatches[0]?.[1]||'', voMatches[1]?.[1]||'', voMatches[2]?.[1]||''];
                                        const veo1 = vp.match(/VEO3\s+CLIP\s+1[^\n]*\n([\s\S]*?)(?=VEO3\s+CLIP\s+2)/)?.[1]?.trim() || '';
                                        const veo2 = vp.match(/VEO3\s+CLIP\s+2[^\n]*\n([\s\S]*?)(?=VEO3\s+CLIP\s+3)/)?.[1]?.trim() || '';
                                        const veo3 = vp.match(/VEO3\s+CLIP\s+3[^\n]*\n([\s\S]*?)(?=REGLA|$)/)?.[1]?.trim() || '';
                                        const beneficioHeroe = vp.match(/BENEFICIO HÉROE[^\n]*\n([^\n]+)/)?.[1]?.trim() || '';
                                        const segs = [
                                            { id: 1, title: 'INICIO', color: '#6366f1', body: seg1, vo: vo1, veo: veo1, fallback: seg1 || vp.split(/CLIP\s+[23]/)[0]?.slice(-300) },
                                            { id: 2, title: 'DESARROLLO', color: '#8b5cf6', body: seg2, vo: vo2, veo: veo2, fallback: seg2 },
                                            { id: 3, title: 'CIERRE', color: '#a855f7', body: seg3, vo: vo3, veo: veo3, fallback: seg3 },
                                        ];
                                        return (
                                            <div style={{ borderBottom: '1px solid var(--z-border)', background: 'rgba(139,92,246,0.05)' }}>
                                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.55rem 0.85rem 0.35rem' }}>
                                                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }}>
                                                        <span style={{ fontSize: '0.58rem', fontWeight: 800, color: '#8b5cf6', textTransform: 'uppercase', letterSpacing: '0.08em' }}>VIDEO 3×10s</span>
                                                        {beneficioHeroe && <span style={{ fontSize: '0.53rem', padding: '1px 6px', background: 'rgba(139,92,246,0.2)', color: '#a78bfa', borderRadius: 20, fontWeight: 700 }}>🎯 {beneficioHeroe.slice(0,40)}</span>}
                                                    </div>
                                                    <div style={{ display: 'flex', gap: '0.3rem' }}>
                                                        {(veo1||veo2||veo3) && <button onClick={() => navigator.clipboard.writeText([veo1,veo2,veo3].filter(Boolean).join('\n\n'))}
                                                            style={{ padding: '2px 8px', background: '#059669', color: '#fff', border: 'none', borderRadius: 4, fontSize: '0.56rem', fontWeight: 700, cursor: 'pointer' }}>
                                                            Copiar Veo3
                                                        </button>}
                                                        <button onClick={() => navigator.clipboard.writeText(vp)}
                                                            style={{ padding: '2px 8px', background: '#8b5cf6', color: '#fff', border: 'none', borderRadius: 4, fontSize: '0.56rem', fontWeight: 700, cursor: 'pointer' }}>
                                                            Copiar todo
                                                        </button>
                                                    </div>
                                                </div>
                                                {(vo1 || vo2 || vo3) && (
                                                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(100px, 1fr))', gap: '0.35rem', padding: '0 0.85rem 0.4rem' }}>
                                                        {[{vo:vo1,i:0},{vo:vo2,i:1},{vo:vo3,i:2}].map(({vo,i}) => vo ? (
                                                            <div key={i} style={{ background: 'rgba(99,102,241,0.1)', borderRadius: 5, padding: '0.3rem 0.45rem', borderLeft: `3px solid ${['#6366f1','#8b5cf6','#a855f7'][i]}` }}>
                                                                <div style={{ fontSize: '0.48rem', color: '#a78bfa', fontWeight: 800, textTransform: 'uppercase', marginBottom: 2 }}>VO Seg {i+1}</div>
                                                                <div style={{ fontSize: '0.58rem', color: 'var(--z-text)', fontStyle: 'italic', lineHeight: 1.35 }}>"{vo}"</div>
                                                            </div>
                                                        ) : <div key={i}/>)}
                                                    </div>
                                                )}
                                                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(100px, 1fr))', gap: '0.35rem', padding: '0 0.85rem 0.45rem' }}>
                                                    {segs.map(seg => (
                                                        <div key={seg.id} style={{ background: 'var(--z-bg-secondary)', borderRadius: 5, overflow: 'hidden', border: `1px solid ${seg.color}35` }}>
                                                            <div style={{ background: seg.color, padding: '0.2rem 0.45rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                                                <span style={{ fontSize: '0.5rem', fontWeight: 800, color: '#fff', textTransform: 'uppercase' }}>Seg {seg.id}</span>
                                                                <span style={{ fontSize: '0.48rem', color: 'rgba(255,255,255,0.8)' }}>{seg.title}</span>
                                                            </div>
                                                            <div style={{ padding: '0.3rem 0.45rem', fontSize: '0.55rem', color: 'var(--z-text-secondary)', lineHeight: 1.45, maxHeight: 120, overflowY: 'auto', whiteSpace: 'pre-wrap' }}>
                                                                {seg.body || '—'}
                                                            </div>
                                                        </div>
                                                    ))}
                                                </div>
                                                {(veo1||veo2||veo3) && (
                                                    <div style={{ margin: '0 0.85rem 0.45rem', padding: '0.45rem 0.55rem', background: 'rgba(5,150,105,0.08)', borderRadius: 6, border: '1px solid rgba(5,150,105,0.25)' }}>
                                                        <div style={{ fontSize: '0.52rem', fontWeight: 800, color: '#059669', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '0.35rem' }}>🎬 Google Veo 3 / Flow — image-to-video prompts</div>
                                                        <div style={{ fontSize: '0.48rem', color: 'var(--z-text-muted)', marginBottom: '0.4rem' }}>Usa la imagen generada como frame 0 en Google Flow para los 3 clips</div>
                                                        {[{label:'CLIP 1 — INICIO', text:veo1, c:'#6366f1'},{label:'CLIP 2 — DESARROLLO', text:veo2, c:'#8b5cf6'},{label:'CLIP 3 — CIERRE', text:veo3, c:'#a855f7'}].filter(x=>x.text).map((x,i) => (
                                                            <div key={i} style={{ marginBottom: '0.3rem', padding: '0.3rem 0.45rem', background: 'var(--z-bg)', borderRadius: 4, borderLeft: `3px solid ${x.c}` }}>
                                                                <div style={{ fontSize: '0.47rem', fontWeight: 800, color: x.c, marginBottom: 2 }}>{x.label}</div>
                                                                <div style={{ fontSize: '0.55rem', color: 'var(--z-text-secondary)', lineHeight: 1.45, whiteSpace: 'pre-wrap', cursor: 'pointer' }} onClick={() => navigator.clipboard.writeText(x.text)}>{x.text}</div>
                                                            </div>
                                                        ))}
                                                    </div>
                                                )}
                                            </div>
                                        );
                                    })()}

                                    {/* Copy preview en modo brief */}
                                    {mode === 'brief' && item.copyPreview && !showCopy[item.taskId] && (
                                        <div style={{ padding: '0.4rem 0.85rem', borderBottom: '1px solid var(--z-border)', fontSize: '0.63rem', color: 'var(--z-text-muted)', lineHeight: 1.4, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                                            {item.copyPreview}
                                        </div>
                                    )}

                                    {/* Imagen principal — solo si no hay picker activo */}
                                    <div style={{ minHeight: 110, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--z-bg-secondary)' }}>
                                        {item.status === 'waiting'    && <div style={{ color: 'var(--z-text-muted)', fontSize: '0.72rem' }}>En espera...</div>}
                                        {item.status === 'generating' && <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.5rem', color: 'var(--z-text-muted)', fontSize: '0.72rem' }}><Loader2 size={22} style={{ animation: 'spin 1s linear infinite', color: ACCENT }} />Generando...</div>}
                                        {item.status === 'qa_check'   && <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.5rem', color: '#a78bfa', fontSize: '0.72rem' }}><Loader2 size={22} style={{ animation: 'spin 1s linear infinite', color: '#a78bfa' }} />QA · validando...</div>}
                                        {item.status === 'done' && item.imageBase64 && <img src={`data:${item.mimeType};base64,${item.imageBase64}`} alt={item.format} style={{ width: '100%', display: 'block', maxHeight: 440, objectFit: 'contain' }} />}
                                        {item.status === 'error' && <div style={{ padding: '1.25rem', textAlign: 'center', color: '#ef4444', fontSize: '0.72rem' }}><AlertCircle size={18} style={{ margin: '0 auto 0.4rem' }} />{item.error || 'Error al generar'}</div>}
                                    </div>

                                    {/* Score bar — el QA decide solo, nunca le pide al usuario que elija entre versiones */}
                                    {item.status === 'done' && item.qaResult && (
                                        <div style={{ padding: '0.35rem 0.7rem', borderTop: '1px solid var(--z-border)' }}>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.6rem', color: 'var(--z-text-muted)' }}>
                                                <span style={{ fontWeight: 700, color: item.qaResult.passed ? '#4ade80' : '#f59e0b' }}>QA {item.qaResult.score}/100</span>
                                                {item.qaResult.issues.length > 0 && <span>· {item.qaResult.issues.length} observación{item.qaResult.issues.length === 1 ? '' : 'es'}</span>}
                                            </div>
                                            {item.qaResult.issues.length > 0 && (
                                                <ul style={{ margin: '0.3rem 0 0', paddingLeft: '1rem', fontSize: '0.6rem', color: 'var(--z-text-muted)', lineHeight: 1.5 }}>
                                                    {item.qaResult.issues.map((iss: string, i: number) => <li key={i}>{translateQaIssue(iss)}</li>)}
                                                </ul>
                                            )}
                                        </div>
                                    )}
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </div>

            <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
        </div>
    );
}

import { AlertTriangle, ArrowRight, Crop, Server, Smartphone, Sparkles, Volume2 } from 'lucide-react';

export interface SystemStatusInfo {
  ffmpegAvailable: boolean;
  ffprobeAvailable: boolean;
  mongodbConfigured: boolean;
  dbMode: 'mongodb' | 'local';
  limits?: {
    maxImageMb: number;
    maxVideoMb: number;
    maxVideoSeconds: number;
    maxStickerKb: number;
  };
}

interface OverviewSectionProps {
  systemStatus: SystemStatusInfo | null;
  onNavigate: (tab: 'creador' | 'panel' | 'instalacion' | 'comandos') => void;
}

export function OverviewSection({ systemStatus, onNavigate }: OverviewSectionProps) {
  const showPreviewWarning =
    systemStatus !== null && (!systemStatus.ffmpegAvailable || systemStatus.dbMode === 'local');
  const maxVideoSeconds = systemStatus?.limits?.maxVideoSeconds ?? 10;

  return (
    <div className="space-y-10">
      {showPreviewWarning && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl px-5 py-4 flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-amber-700 shrink-0 mt-0.5" />
          <div className="text-xs sm:text-sm text-amber-950 leading-relaxed space-y-1">
            <p className="font-semibold">Aviso del entorno de vista previa</p>
            <p>
              {!systemStatus.ffmpegAvailable
                ? 'FFmpeg no está disponible en esta vista previa (solo afectará a stickers de video hasta desplegar el Dockerfile en Render). '
                : 'FFmpeg está detectado en este contenedor. '}
              {systemStatus.dbMode === 'local'
                ? 'MONGODB_URI no está configurada aquí, por lo que las sesiones usan almacenamiento local temporal. Al desplegar en Render con MongoDB Atlas Free, tus sesiones permanecerán guardadas.'
                : 'MongoDB Atlas conectado.'}
            </p>
          </div>
        </div>
      )}

      <section className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-stretch">
        <div className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-8 flex flex-col justify-between">
          <div>
            <p className="text-xs font-medium text-slate-500 tracking-wide mb-3">
              Render Free + Docker · Node.js 22 LTS · Baileys v7 ESM · Multi-usuario
            </p>
            <h1 className="font-display text-3xl sm:text-4xl font-bold text-slate-900 tracking-tight leading-tight text-balance mb-4">
              Crea stickers y envíalos a tu grupo de WhatsApp desde la web
            </h1>
            <p className="text-slate-600 text-base leading-relaxed mb-6 max-w-2xl">
              Recorta tus fotos y videos, añade texto con colores y envía stickers 512×512 directo
              al grupo autorizado — sin comandos. También puedes vincular WhatsApp por código QR o
              código de 8 dígitos y usar los comandos dentro del grupo.
            </p>
          </div>

          <div className="space-y-3 pt-4 border-t border-slate-100">
            <div className="flex flex-wrap items-center gap-2.5">
              <button
                type="button"
                onClick={() => onNavigate('creador')}
                className="inline-flex items-center gap-2 px-5 py-3 bg-green-700 hover:bg-green-800 text-white text-sm sm:text-base font-bold rounded-xl shadow-sm transition-colors whitespace-nowrap shrink-0"
              >
                <Sparkles className="w-4 h-4 sm:w-5 sm:h-5" />
                Abrir creador de stickers
              </button>

              <button
                type="button"
                onClick={() => onNavigate('panel')}
                className="inline-flex items-center gap-2 px-4 py-3 bg-slate-900 hover:bg-slate-800 text-white text-sm font-semibold rounded-xl transition-colors whitespace-nowrap shrink-0"
              >
                <Smartphone className="w-4 h-4" />
                Panel WhatsApp
              </button>

              <button
                type="button"
                onClick={() => onNavigate('instalacion')}
                className="inline-flex items-center gap-1.5 px-3 py-3 text-slate-700 hover:text-slate-900 text-sm font-medium transition-colors whitespace-nowrap shrink-0"
              >
                Guía Render
                <ArrowRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>

        <div className="lg:col-span-5 bg-slate-900 text-slate-100 rounded-xl p-8 flex flex-col justify-between">
          <div>
            <p className="text-xs font-medium text-slate-400 mb-3">
              Diagnóstico de grupo en WhatsApp
            </p>
            <pre className="font-mono text-sm leading-relaxed text-emerald-300 bg-slate-950/70 border border-slate-800 rounded-lg p-4 overflow-x-auto">
{`┌──────────────────────┐
 STICKERBOT
 Tu creador de stickers
└──────────────────────┘

ID de este grupo detectado:
120363012345678901@g.us

Copia este ID o pulsa
"Usar este grupo" en tu
panel web de StickerBot.`}
            </pre>
          </div>
          <p className="text-xs text-slate-400 mt-5 leading-relaxed">
            Envía <code className="text-emerald-300 font-mono">//pingdiag</code> en tu grupo para autorizarlo desde el panel web sin editar archivos manualmente.
          </p>
        </div>
      </section>

      <section className="grid grid-cols-1 md:grid-cols-4 gap-4 bg-white border border-slate-200 rounded-xl p-6">
        <div className="space-y-1">
          <p className="text-xs text-slate-500">Creador web</p>
          <p className="font-mono text-base font-semibold text-slate-900 tabular-nums">
            Foto · Video · Texto
          </p>
          <p className="text-xs text-slate-600">Recorte y envío directo al grupo</p>
        </div>
        <div className="space-y-1">
          <p className="text-xs text-slate-500">Stickers animados</p>
          <p className="font-mono text-base font-semibold text-slate-900 tabular-nums">
            {maxVideoSeconds} s · &lt; 500 KB
          </p>
          <p className="text-xs text-slate-600">Límite oficial de WhatsApp</p>
        </div>
        <div className="space-y-1">
          <p className="text-xs text-slate-500">Consumo optimizado</p>
          <p className="font-mono text-base font-semibold text-slate-900 tabular-nums">
            Cola 1 video / vez
          </p>
          <p className="text-xs text-slate-600">Limpieza automática en /tmp</p>
        </div>
        <div className="space-y-1">
          <p className="text-xs text-slate-500">Base de datos</p>
          <p className="font-mono text-base font-semibold text-green-700 tabular-nums">
            {systemStatus?.dbMode === 'mongodb' ? 'MongoDB Atlas' : 'Híbrida (Mongo / Local)'}
          </p>
          <p className="text-xs text-slate-600">Sesiones persistentes por usuario</p>
        </div>
      </section>

      <section className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <article className="bg-white border border-slate-200 rounded-xl p-6 space-y-3">
          <div className="flex items-center gap-2 text-slate-900 font-semibold text-base">
            <Crop className="w-4 h-4 text-green-700 shrink-0" />
            <h3>Recorte cuadrado inteligente</h3>
          </div>
          <p className="text-sm text-slate-600 leading-relaxed">
            En el creador web eliges la zona exacta de tus fotos y el fragmento exacto de tus
            videos (hasta {maxVideoSeconds} s). Los comandos{' '}
            <code className="font-mono text-xs bg-slate-100 px-1.5 py-0.5 rounded">/gif</code> y{' '}
            <code className="font-mono text-xs bg-slate-100 px-1.5 py-0.5 rounded">/stickeraudio</code>{' '}
            recortan automáticamente al centro; añade{' '}
            <code className="font-mono text-xs bg-slate-100 px-1.5 py-0.5 rounded">completo</code>{' '}
            para conservar todo el encuadre.
          </p>
        </article>

        <article className="bg-white border border-slate-200 rounded-xl p-6 space-y-3">
          <div className="flex items-center gap-2 text-slate-900 font-semibold text-base">
            <Volume2 className="w-4 h-4 text-green-700 shrink-0" />
            <h3>Sound Stickers nativos (campo 26)</h3>
          </div>
          <p className="text-sm text-slate-600 leading-relaxed">
            Incrusta el audio OGG/Opus sincronizado con la duración exacta del WebP animado dentro del campo protobuf{' '}
            <code className="font-mono text-xs bg-slate-100 px-1.5 py-0.5 rounded">26</code> de{' '}
            <code className="font-mono text-xs bg-slate-100 px-1.5 py-0.5 rounded">StickerMessage</code>,
            enviando un único sticker con botón de sonido.
          </p>
        </article>

        <article className="bg-white border border-slate-200 rounded-xl p-6 space-y-3">
          <div className="flex items-center gap-2 text-slate-900 font-semibold text-base">
            <Server className="w-4 h-4 text-green-700 shrink-0" />
            <h3>Seguro para 512 MB de RAM</h3>
          </div>
          <p className="text-sm text-slate-600 leading-relaxed">
            Procesa un trabajo FFmpeg a la vez mediante cola secuencial, escribe en rutas únicas de{' '}
            <code className="font-mono text-xs bg-slate-100 px-1.5 py-0.5 rounded">os.tmpdir()</code>{' '}
            y elimina archivos temporales inmediatamente al terminar o cada 10 minutos.
          </p>
        </article>
      </section>
    </div>
  );
}

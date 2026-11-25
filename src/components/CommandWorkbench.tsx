import { useMemo, useState } from 'react';
import {
  COMMAND_DOCS,
  STICKER_COLORS,
  computeStickerTextLayout,
} from '../utils/stickerPreview';

export function CommandWorkbench() {
  const [textInput, setTextInput] = useState('/stickertexto Hola mundo 😎');
  const [selectedColorHex, setSelectedColorHex] = useState<string | undefined>(undefined);
  const [activeCommand, setActiveCommand] = useState<string>('/menu');

  const layout = useMemo(
    () => computeStickerTextLayout(textInput, selectedColorHex),
    [textInput, selectedColorHex]
  );

  const selectedDoc = useMemo(
    () => COMMAND_DOCS.find((doc) => doc.command === activeCommand) || COMMAND_DOCS[0],
    [activeCommand]
  );

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
      <section className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-6 space-y-5">
        <div>
          <h2 className="font-display text-xl font-bold text-slate-900">
            Probador visual de /stickertexto
          </h2>
          <p className="text-sm text-slate-600 mt-1">
            Simula exactamente cómo StickerBot centra, ajusta el tamaño, añade contorno y genera transparencia en 512x512 WebP.
          </p>
        </div>

        <div className="space-y-2">
          <label htmlFor="sticker-text-input" className="block text-xs font-semibold text-slate-700">
            Escribe el comando como en WhatsApp
          </label>
          <input
            id="sticker-text-input"
            type="text"
            value={textInput}
            onChange={(e) => {
              setSelectedColorHex(undefined);
              setTextInput(e.target.value);
            }}
            placeholder="/stickertexto rojo Hola mundo"
            className="w-full px-3.5 py-2.5 text-sm font-mono bg-slate-50 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-700"
          />
        </div>

        <div className="space-y-2">
          <p className="text-xs font-semibold text-slate-700">Color del texto</p>
          <div className="flex flex-wrap gap-2">
            {STICKER_COLORS.map((color) => {
              const active = layout.fillColor.toUpperCase() === color.hex.toUpperCase();
              return (
                <button
                  key={color.name}
                  type="button"
                  onClick={() => setSelectedColorHex(color.hex)}
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-md border transition-colors whitespace-nowrap ${
                    active
                      ? 'border-green-700 bg-green-50 text-green-900'
                      : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  <span
                    className="w-3 h-3 rounded-sm border border-slate-300 shrink-0"
                    style={{ backgroundColor: color.hex }}
                  />
                  {color.label}
                </button>
              );
            })}
          </div>
        </div>

        <div className="checkerboard-bg border border-slate-200 rounded-xl p-4 flex items-center justify-center">
          <svg
            viewBox="0 0 512 512"
            className="w-64 h-64 sm:w-72 sm:h-72"
            role="img"
            aria-label={`Vista previa del sticker con el texto ${layout.text}`}
          >
            <defs>
              <filter id="previewStickerShadow" x="-20%" y="-20%" width="140%" height="140%">
                <feDropShadow dx="0" dy="5" stdDeviation="4" floodColor="#000000" floodOpacity="0.5" />
              </filter>
            </defs>
            {layout.lines.map((line, index) => (
              <text
                key={`${index}-${line}`}
                x="256"
                y={layout.firstBaselineY + index * layout.lineHeight}
                textAnchor="middle"
                fontFamily="Plus Jakarta Sans, Segoe UI Emoji, Noto Color Emoji, sans-serif"
                fontWeight="800"
                fontSize={layout.fontSize}
                fill={layout.fillColor}
                stroke={layout.strokeColor}
                strokeWidth={layout.strokeWidth}
                strokeLinejoin="round"
                paintOrder="stroke fill"
                filter="url(#previewStickerShadow)"
              >
                {line}
              </text>
            ))}
          </svg>
        </div>

        <p className="text-xs text-slate-500 font-mono tabular-nums">
          Lienzo: 512x512 px · Fuente: {layout.fontSize}px · Líneas: {layout.lines.length} · Fondo transparente
        </p>
      </section>

      <section className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-6 space-y-5">
        <div>
          <h2 className="font-display text-xl font-bold text-slate-900">
            Catálogo de comandos y respuestas esperadas
          </h2>
          <p className="text-sm text-slate-600 mt-1">
            Selecciona cualquier comando para revisar cómo se usa en el grupo y qué responderá StickerBot.
          </p>
        </div>

        <div className="flex flex-wrap gap-1.5 p-1 bg-slate-100 rounded-lg">
          {COMMAND_DOCS.map((doc) => {
            const isSelected = doc.command === selectedDoc.command;
            return (
              <button
                key={doc.command}
                type="button"
                onClick={() => setActiveCommand(doc.command)}
                className={`px-3 py-1.5 text-xs font-mono font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                  isSelected
                    ? 'bg-white text-green-800 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {doc.command}
              </button>
            );
          })}
        </div>

        <div className="space-y-4 pt-2">
          <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-slate-100 pb-3">
            <h3 className="font-mono text-lg font-bold text-slate-900">
              {selectedDoc.command}
              {selectedDoc.aliases && (
                <span className="text-sm font-normal text-slate-500 ml-2">
                  (también {selectedDoc.aliases.join(', ')})
                </span>
              )}
            </h3>
            <span className="text-xs text-slate-500">
              {selectedDoc.category}
              {selectedDoc.requiresFfmpeg ? ' · Requiere FFmpeg' : ''}
            </span>
          </div>

          <p className="text-sm text-slate-700 leading-relaxed">{selectedDoc.summary}</p>

          <div className="text-sm">
            <span className="text-xs font-semibold text-slate-500 block mb-1">
              Ejemplo de uso en el grupo
            </span>
            <code className="inline-block font-mono text-xs bg-slate-100 text-slate-900 px-3 py-1.5 rounded-md">
              {selectedDoc.example}
            </code>
          </div>

          <div>
            <span className="text-xs font-semibold text-slate-500 block mb-1.5">
              Respuesta del bot en WhatsApp
            </span>
            <pre className="font-mono text-xs sm:text-sm leading-relaxed bg-slate-900 text-emerald-300 rounded-lg p-4 overflow-x-auto whitespace-pre-wrap">
              {selectedDoc.sampleReply}
            </pre>
          </div>
        </div>
      </section>
    </div>
  );
}

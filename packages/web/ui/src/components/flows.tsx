import type { Flow, FlowState, SourcedFlow } from "@norn/core";
import { useId } from "react";
import { colorOf, type FlowEdge, flowGraph } from "../model.ts";
import { useView } from "../view.ts";
import { FLOWS, behaviourParams, capitalise, flowErrorText, flowFacts, flowSourceHint, flowSourceLabel, onlyIn } from "../wording.ts";
import { Badge } from "./ui/badge.tsx";

/** The read-only Flows page: every flow of the repository, where it comes from, whether it is valid, and its graph. */
export function FlowsPage() {
  const { state } = useView();
  return (
    <div>
      <h1 className="mt-0 mb-1.5 font-semibold text-[26px] leading-[1.25] tracking-[-0.02em]">{FLOWS.title}</h1>
      <p className="mt-0 mb-7 text-muted-foreground">{FLOWS.sub}</p>
      {state.flows.length === 0 && <p className="text-[14px] text-muted-foreground">{FLOWS.none}</p>}
      {state.flows.map((f) => (
        <FlowCard key={f.name} f={f} />
      ))}
    </div>
  );
}

function FlowCard({ f }: { f: SourcedFlow }) {
  return (
    <section aria-label={f.name} className="mb-6 rounded-[14px] border border-border bg-card px-[18px] py-4">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <h2 className="m-0 mr-1 font-semibold text-[17px] tracking-[-0.01em]">{capitalise(f.name)}</h2>
        <Badge title={flowSourceHint(f.source, f.name)}>{flowSourceLabel(f.source)}</Badge>
        <Badge tone={f.ok ? "neutral" : "bad"}>{f.ok ? FLOWS.valid : FLOWS.invalid}</Badge>
      </div>
      {f.ok ? (
        <>
          <p className="mt-0 mb-0.5 text-soft">{f.flow.description}</p>
          <p className="mt-0 mb-4 text-[13px] text-faint">{flowFacts(f.flow)}</p>
          <FlowDiagram flow={f.flow} />
          <StateList flow={f.flow} />
        </>
      ) : (
        <ul className="m-0 mt-2.5 list-none rounded-xl bg-bad-bg px-4 py-3 text-[14px] text-soft">
          {f.errors.map((e, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the errors are a fixed list, read once.
            <li key={i} className="py-0.5">
              <span className="mr-1.5 text-bad">✕</span>
              {flowErrorText(e)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const NODE_W = 184;
const NODE_H = 66;
const END_W = 104;
const END_H = 30;
const GAP_X = 64;
const GAP_Y = 64;
/** Room on each side for the arrows that skip layers (left) or lead back up (right). */
const SIDE = 80;
const PAD = 12;

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  layer: number;
}

/** The flow as a graph: its states in layers from the start, its ends at the bottom, an arrow per way with the outcome words that take it. */
function FlowDiagram({ flow }: { flow: Flow }) {
  const arrow = useId();
  const { layers, edges, ends } = flowGraph(flow);
  const widest = Math.max(1, ...layers.map((l) => l.length));
  const inner = widest * NODE_W + (widest - 1) * GAP_X;
  const width = SIDE + inner + SIDE;
  const boxes = new Map<string, Box>();
  let y = PAD;
  for (const [i, layer] of layers.entries()) {
    const h = layer.every((s) => ends.has(s)) ? END_H : NODE_H;
    const row = layer.length * NODE_W + (layer.length - 1) * GAP_X;
    for (const [j, s] of layer.entries()) {
      const slot = SIDE + (inner - row) / 2 + j * (NODE_W + GAP_X);
      boxes.set(s, ends.has(s) ? { x: slot + (NODE_W - END_W) / 2, y, w: END_W, h, layer: i } : { x: slot, y, w: NODE_W, h, layer: i });
    }
    y += h + GAP_Y;
  }
  const height = y - GAP_Y + PAD;
  // Arrows that skip layers or lead back stack out to the sides, each a little further out.
  const lanes = { left: 0, right: 0 };
  const paths = edges.flatMap((e) => {
    const a = boxes.get(e.from);
    const b = boxes.get(e.to);
    return a && b ? [{ e, ...route(a, b, lanes, { left: SIDE, right: SIDE + inner }) }] : [];
  });
  return (
    <div className="-mx-1 mb-4 overflow-x-auto">
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={FLOWS.graph} className="block">
        <defs>
          <marker id={arrow} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="var(--faint)" />
          </marker>
        </defs>
        {paths.map(({ e, d }) => (
          <path
            key={`${e.from}>${e.to}>${e.by ?? ""}`}
            d={d}
            fill="none"
            stroke="var(--faint)"
            strokeWidth={1.25}
            strokeDasharray={e.by ? "4 3" : undefined}
            markerEnd={`url(#${arrow})`}
          />
        ))}
        {paths.map(({ e, label }) => (
          <text
            key={`${e.from}>${e.to}>${e.by ?? ""}`}
            x={label.x}
            y={label.y}
            textAnchor="middle"
            dominantBaseline="middle"
            className="fill-muted-foreground font-mono text-[10.5px]"
            stroke="var(--card)"
            strokeWidth={4}
            paintOrder="stroke"
            strokeLinejoin="round"
          >
            {edgeLabel(e)}
          </text>
        ))}
        {[...boxes].map(([name, b]) =>
          ends.has(name) ? (
            <g key={name}>
              <rect x={b.x} y={b.y} width={b.w} height={b.h} rx={b.h / 2} fill="var(--muted)" stroke="var(--border)" />
              <text x={b.x + b.w / 2} y={b.y + b.h / 2} textAnchor="middle" dominantBaseline="middle" className="fill-muted-foreground font-mono text-[11.5px]">
                {name}
              </text>
            </g>
          ) : (
            <StateNode key={name} name={name} s={flow.states[name]!} start={name === flow.start} b={b} />
          ),
        )}
      </svg>
    </div>
  );
}

type Route = { d: string; label: { x: number; y: number } };

/**
 * An arrow's path and where its words go: down into the next layer; across to a state beside it; out to the left and
 * down when it skips layers, so it passes no state; out to the right and back up when it leads back.
 */
function route(a: Box, b: Box, lanes: { left: number; right: number }, bounds: { left: number; right: number }): Route {
  const midA = a.y + a.h / 2;
  const midB = b.y + b.h / 2;
  if (b.layer === a.layer + 1) {
    const [x1, y1, x2, y2] = [a.x + a.w / 2, a.y + a.h, b.x + b.w / 2, b.y];
    const bend = (y2 - y1) / 2;
    return { d: `M${x1},${y1} C${x1},${y1 + bend} ${x2},${y2 - bend} ${x2},${y2}`, label: { x: (x1 + x2) / 2, y: (y1 + y2) / 2 } };
  }
  if (b.layer === a.layer) {
    const [x1, x2] = b.x > a.x ? [a.x + a.w, b.x] : [a.x, b.x + b.w];
    return { d: `M${x1},${midA} L${x2},${midB}`, label: { x: (x1 + x2) / 2, y: midA - 10 } };
  }
  if (b.layer > a.layer) {
    const out = bounds.left - 14 - (lanes.left++ % 4) * 14;
    return { d: `M${a.x},${midA} C${out},${midA} ${out},${midB} ${b.x},${midB}`, label: { x: out + 6, y: (midA + midB) / 2 } };
  }
  const out = bounds.right + 14 + (lanes.right++ % 4) * 14;
  const [x1, x2] = [a.x + a.w, b.x + b.w];
  return { d: `M${x1},${midA} C${out},${midA} ${out},${midB} ${x2},${midB}`, label: { x: out - 6, y: (midA + midB) / 2 } };
}

function edgeLabel(e: FlowEdge): string {
  return e.by ? e.by : e.words.join(", ");
}

/** One state: its name, its step and who runs it, its colour, and the mode and behaviours it carries. */
function StateNode({ name, s, start, b }: { name: string; s: FlowState; start: boolean; b: Box }) {
  const { state } = useView();
  const marks = [...(s.when ? [onlyIn(s.when)] : []), ...Object.keys(s.behaviours ?? {})];
  return (
    <g>
      <rect
        x={b.x}
        y={b.y}
        width={NODE_W}
        height={b.h}
        rx={10}
        fill="var(--card)"
        stroke={start ? "var(--live)" : "var(--border)"}
        strokeWidth={start ? 1.5 : 1}
        strokeDasharray={s.when ? "5 3" : undefined}
      />
      <rect x={b.x + 8} y={b.y + 11} width={7} height={7} rx={3.5} fill={colorOf(s, state.stateLabelDefaults)} />
      <foreignObject x={b.x + 20} y={b.y + 4} width={NODE_W - 26} height={b.h - 8}>
        <div className="flex h-full flex-col justify-center gap-px overflow-hidden text-[11.5px] leading-[1.35]">
          <div className="truncate font-medium font-mono text-[12px] text-foreground" title={name}>
            {name}
            {start && <span className="ml-1.5 font-sans font-normal text-[10.5px] text-live">{FLOWS.start}</span>}
          </div>
          <div className="truncate text-muted-foreground">
            {s.name ?? name} · {s.attended ? FLOWS.attended : FLOWS.agent}
          </div>
          {marks.length > 0 && (
            <div className="truncate text-[10.5px] text-warn" title={marks.join(", ")}>
              {marks.join(" · ")}
            </div>
          )}
        </div>
      </foreignObject>
    </g>
  );
}

/** Every state in words, for what the graph leaves out: what it means, its skill, its behaviours' parameters, each outcome's meaning. */
function StateList({ flow }: { flow: Flow }) {
  const { state } = useView();
  const { layers, ends } = flowGraph(flow);
  const states = layers.flat().filter((s) => !ends.has(s));
  return (
    <details className="text-[13.5px]">
      <summary className="cursor-pointer text-[13px] text-faint">{FLOWS.states}</summary>
      <ul className="m-0 mt-2 list-none p-0">
        {states.map((name) => {
          const s = flow.states[name]!;
          return (
            <li key={name} className="border-border border-t py-2.5 text-soft">
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-block size-[7px] rounded-full" style={{ background: colorOf(s, state.stateLabelDefaults) }} />
                <span className="font-medium font-mono text-[12.5px] text-foreground">{name}</span>
                <span className="text-muted-foreground">{s.description ?? ""}</span>
              </div>
              <div className="mt-0.5 text-[12.5px] text-faint">
                {s.name ?? name} · {s.attended ? FLOWS.attended : FLOWS.agent} · <span className="font-mono">{s.skill}</span>
                {s.enterAs && ` · taken as ${s.enterAs}`}
                {s.evidence && " · attaches evidence"}
              </div>
              {(s.when || s.behaviours) && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {s.when && <Badge tone="warn">{s.passThrough ? `${onlyIn(s.when)}, else ${s.passThrough}` : onlyIn(s.when)}</Badge>}
                  {Object.entries(s.behaviours ?? {}).map(([b, params]) => {
                    const p = behaviourParams(params);
                    return <Badge key={b}>{p ? `${b} (${p})` : b}</Badge>;
                  })}
                </div>
              )}
              {Object.keys(s.outcomes).length > 0 && (
                <ul className="m-0 mt-1 list-none p-0 text-[12.5px]">
                  {Object.entries(s.outcomes).map(([word, o]) => (
                    <li key={word} className="py-px">
                      <span className="font-mono text-foreground">{word}</span> <span className="text-faint">→</span> <span className="font-mono">{o.to}</span>
                      <span className="text-muted-foreground">: {o.means}</span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </details>
  );
}

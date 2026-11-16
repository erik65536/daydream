/**
 * Data to read: what a step answered, what a record holds, what the engine lays out. A few general rules make any
 * answer read like a document rather than a tree:
 *   - entries keyed by id are sections, headed by their id and name;
 *   - a list of flat rows that share their fields is a table;
 *   - any other list of objects is numbered cards, headed by their kind and name;
 *   - other objects are fields beside their names; colors show their color.
 * An id that something is named for (a place, a story person) shows that name beside it. JSON is a click away for
 * exactness.
 */
import { createContext, useContext, useState, type ReactNode } from 'react';

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const isAtom = (v: unknown) => v === null || typeof v !== 'object';
/** A field that names its object, shown as its heading. */
const TITLE = ['name', 'title', 'label'];
const titleKey = (o: Obj) => TITLE.find((k) => typeof o[k] === 'string');
const HEX = /^#[0-9a-fA-F]{6}$/;

/** What ids are called (`t0_0` → its place's name), from the example's newest answers. */
export const Names = createContext<Record<string, string>>({});

export function Ref({ id }: { id: string }) {
  const name = useContext(Names)[id];
  return (
    <span className="v-named">
      <span className="v-ref">{id}</span>
      {name && <span>{name}</span>}
    </span>
  );
}

export function Value({ value }: { value: unknown }) {
  const names = useContext(Names);
  if (value === null || value === undefined) return <span className="v-none">nothing</span>;
  if (typeof value === 'string') {
    if (Object.hasOwn(names, value)) return <Ref id={value} />;
    if (HEX.test(value))
      return (
        <span className="v-color">
          <span className="v-swatch" style={{ background: value }} />
          {value}
        </span>
      );
    return value ? <span className="v-text">{value}</span> : <span className="v-none">empty</span>;
  }
  if (typeof value !== 'object') return <span className="v-atom">{String(value)}</span>;
  if (Array.isArray(value)) return <List items={value} />;
  return <Fields value={value as Obj} />;
}

function Fields({ value, skip }: { value: Obj; skip?: string[] }) {
  const entries = Object.entries(value).filter(([k]) => !skip?.includes(k));
  if (!entries.length) return <span className="v-none">no fields</span>;
  // Entries keyed by id (the places, the cast, the arcs): each is a section of its own.
  if (entries.every(([, v]) => isObj(v)))
    return (
      <div className="v-sections">
        {entries.map(([k, v]) => {
          const o = v as Obj;
          const t = titleKey(o);
          return (
            <details key={k} className="v-section" open>
              <summary>
                <span className="v-id">{k}</span>
                {t && <span className="v-title">{o[t] as string}</span>}
              </summary>
              <Fields value={o} skip={t ? [t] : []} />
            </details>
          );
        })}
      </div>
    );
  return (
    <dl className="v-fields">
      {entries.map(([k, v]) => (
        <div key={k} className={isAtom(v) ? 'v-field' : 'v-field v-field-block'}>
          <dt>{k}</dt>
          <dd>
            <Value value={v} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

function List({ items }: { items: unknown[] }) {
  if (!items.length) return <span className="v-none">none</span>;
  if (items.every((v) => typeof v !== 'object' || v === null)) {
    const short = items.every((v) => String(v).length <= 40);
    return short ? (
      <span className="v-chips">
        {items.map((v, i) => (
          <span key={i} className="v-chip">
            <Value value={v} />
          </span>
        ))}
      </span>
    ) : (
      <ul className="v-bullets">
        {items.map((v, i) => (
          <li key={i}>
            <Value value={v} />
          </li>
        ))}
      </ul>
    );
  }
  if (items.every(isObj)) {
    const columns = tableColumns(items as Obj[]);
    if (columns) return <Table rows={items as Obj[]} columns={columns} />;
    return (
      <ol className="v-cards">
        {(items as Obj[]).map((o, i) => {
          const t = titleKey(o);
          const kind = typeof o.kind === 'string' ? o.kind : undefined;
          return (
            <li key={i} className="v-card">
              <div className="v-card-head">
                <span className="v-n">{i + 1}</span>
                {kind && <span className="v-kind">{kind}</span>}
                {t && <span className="v-title">{o[t] as string}</span>}
              </div>
              <Fields value={o} skip={[...(t ? [t] : []), ...(kind ? ['kind'] : [])]} />
            </li>
          );
        })}
      </ol>
    );
  }
  return (
    <ol className="v-cards">
      {items.map((v, i) => (
        <li key={i} className="v-card">
          <Value value={v} />
        </li>
      ))}
    </ol>
  );
}

/** The columns of a list that reads best as a table: rows of the same few short fields (an object cell shows its id). */
function tableColumns(rows: Obj[]): string[] | undefined {
  const keys = Object.keys(rows[0]!);
  if (keys.length > 9) return undefined;
  const same = rows.every((r) => Object.keys(r).length === keys.length && keys.every((k) => k in r));
  const flat = rows.every((r) => keys.every((k) => (isAtom(r[k]) && String(r[k]).length <= 60) || (isObj(r[k]) && typeof (r[k] as Obj).id === 'string')));
  return same && flat ? keys : undefined;
}

function Table({ rows, columns }: { rows: Obj[]; columns: string[] }) {
  return (
    <div className="v-table-wrap">
      <table className="v-table">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {columns.map((c) => (
                <td key={c}>{isObj(r[c]) ? <Ref id={(r[c] as Obj).id as string} /> : <Value value={r[c]} />}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Data as readable views or as exact JSON, with a copy button. */
export function DataView({ value, toolbar }: { value: unknown; toolbar?: ReactNode }) {
  const [raw, setRaw] = useState(false);
  const [copied, setCopied] = useState(false);
  const text = () => JSON.stringify(value, null, 2);
  return (
    <div className="data">
      <div className="data-bar">
        {toolbar}
        <div className="data-bar-end">
          <div className="toggle">
            <button className={raw ? '' : 'on'} onClick={() => setRaw(false)}>
              Readable
            </button>
            <button className={raw ? 'on' : ''} onClick={() => setRaw(true)}>
              JSON
            </button>
          </div>
          <button
            className="quiet"
            onClick={() =>
              navigator.clipboard.writeText(text()).then(
                () => (setCopied(true), setTimeout(() => setCopied(false), 1200)),
                () => undefined,
              )
            }
          >
            {copied ? 'Copied' : 'Copy JSON'}
          </button>
        </div>
      </div>
      {raw ? <pre className="code">{text()}</pre> : <Value value={value} />}
    </div>
  );
}

/**
 * A JSON Schema drawn as the shape of the data: each field with its type in plain words and its description. The
 * words come from the pipeline's own rules (server/src/pipeline/shape.ts), which the CLI prints too.
 */
import { inside, keyed, typeWords, unwrap, type S } from '../../../server/src/pipeline/shape.ts';
import { Ref } from './Value.tsx';

/** What goes inside a field: its fields, its kinds, its values, or what each item or entry holds. */
function Inner({ s }: { s: S }) {
  const i = inside(s);
  if (i.kind === 'values')
    return (
      <div className="sh-values">
        {i.values.map((v) => (
          <span key={String(v)} className="v-chip">
            {String(v)}
          </span>
        ))}
      </div>
    );
  if (i.kind === 'kinds')
    return (
      <div className="sh-kinds">
        {i.kinds.map((k, n) => (
          <div key={n} className="sh-kind">
            <div className="sh-kind-head">
              {k.tag ? <span className="v-kind">{k.tag}</span> : <span className="v-n">{n + 1}</span>}
              {k.shape.description && <span className="sh-about"> {k.shape.description}</span>}
            </div>
            <Fields fields={Object.entries(k.shape.properties ?? {})} />
          </div>
        ))}
      </div>
    );
  if (i.kind === 'fields')
    return (
      <>
        {i.keys && (
          <div className="sh-values">
            {i.keys.map((key) => (
              <Ref key={key} id={key} />
            ))}
          </div>
        )}
        <Fields fields={i.fields} />
      </>
    );
  return null;
}

function Fields({ fields }: { fields: [string, S][] }) {
  return (
    <div className="sh-fields">
      {fields.map(([name, f]) => (
        <Field key={name} name={name} s={f} />
      ))}
    </div>
  );
}

function Field({ name, s }: { name: string; s: S }) {
  const about = s.description ?? unwrap(s).s.description;
  const holds = inside(s).kind !== 'none';
  return (
    <div className="sh-field">
      <div className="sh-line">
        <span className="sh-name">{name}</span>
        <span className="sh-type">{typeWords(s)}</span>
      </div>
      {about && <div className="sh-about">{about}</div>}
      {holds && (
        <div className="sh-inner">
          <Inner s={s} />
        </div>
      )}
    </div>
  );
}

export function Shape({ schema }: { schema: unknown }) {
  const s = schema as S;
  return (
    <div className="shape">
      {s.description && <div className="sh-about sh-top">{s.description}</div>}
      {keyed(s) || s.type !== 'object' ? (
        <>
          <div className="sh-type sh-top">{typeWords(s)}</div>
          <Inner s={s} />
        </>
      ) : (
        <Inner s={s} />
      )}
    </div>
  );
}

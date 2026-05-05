import SpellPreview from './SpellPreview.jsx'

export default function SpellDetail({ spell }) {
  return (
    <div className="spell-detail">
      <div className="spell-detail-head">
        <span className="spells-step">Spell</span>
        <h2>{spell.name}</h2>
        <code className="spell-detail-id">{spell.id}</code>
      </div>

      <SpellPreview spell={spell} />

      <div className="spell-detail-section">
        <h3>Prompt</h3>
        <p className="spell-detail-prompt">{spell.prompt}</p>
      </div>

      <div className="spell-detail-section">
        <h3>Schema</h3>
        <pre className="spell-detail-schema">
          <code>{JSON.stringify(spell.schema, null, 2)}</code>
        </pre>
      </div>
    </div>
  )
}

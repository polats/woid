/**
 * Story-so-far overlay — toggled from the bottom-left Stage tab.
 *
 * Mirrors the Build carousel's slide-down overlay so the two
 * bottom-bar toggles feel like one family. Content is the
 * trailer's running narrative; edit the entries inline.
 */

const ENTRIES = [
  {
    chapter: 'I',
    title: 'Two names on the manifest',
    body: 'Jeremias and Elina arrive the same week. Neither acts surprised to see the other.',
    tags: ['Jeremias', 'Elina', 'Lobby'],
  },
  {
    chapter: 'II',
    title: 'Adjacent desks',
    body: 'Assigned to neighbouring rooms, they finish each other\'s sentences without noticing.',
    tags: ['Jeremias', 'Elina', 'Pattern Sorting'],
  },
  {
    chapter: 'III',
    title: 'A folder, a pause',
    body: 'Late in the microfilm room their hands brush. Elina starts to ask something and stops — a bond is forming you didn\'t put there.',
    tags: ['Elina', 'Jeremias', 'Microfilm Reading Room'],
  },
]

export default function ShelterStoryPanel({ open, onClose }) {
  return (
    <div className={`shelter-story-panel${open ? ' visible' : ''}`}>
      <div className="shelter-story-panel-head">
        <span className="shelter-story-panel-title">Story so far</span>
        <button
          type="button"
          className="shelter-story-panel-close"
          onClick={onClose}
          aria-label="Close story"
        >×</button>
      </div>
      <ol className="shelter-story-panel-list">
        {ENTRIES.map((e) => (
          <li key={e.chapter} className="shelter-story-entry">
            <div className="shelter-story-entry-head">
              <span className="shelter-story-entry-chapter">{e.chapter}</span>
              <strong className="shelter-story-entry-title">{e.title}</strong>
            </div>
            <p className="shelter-story-entry-body">{e.body}</p>
            {e.tags?.length > 0 && (
              <div className="shelter-story-entry-tags">
                {e.tags.map((t) => (
                  <span key={t} className="shelter-story-entry-tag">{t}</span>
                ))}
              </div>
            )}
          </li>
        ))}
      </ol>
    </div>
  )
}

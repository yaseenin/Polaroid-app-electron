import { useState } from 'react'
import './App.css'

function App() {
  const [darkMode, setDarkMode] = useState(true)

  return (
    <div className={`app ${darkMode ? 'dark' : 'light'}`}>
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">P</div>
          <div>
            <div className="brand-name">POLAROID</div>
            <div className="brand-subtitle">Photo Studio</div>
          </div>
        </div>

        <div className="topbar-actions">
          <button className="toolbar-button">New</button>
          <button className="toolbar-button">Open</button>
          <button className="toolbar-button">Save</button>

          <div className="toolbar-divider" />

          <button
            className="theme-toggle"
            onClick={() => setDarkMode((value) => !value)}
            title={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            <span className="theme-icon">{darkMode ? '☀' : '☾'}</span>
            <span>{darkMode ? 'Light' : 'Dark'}</span>
          </button>

          <button className="toolbar-button settings-button">
            Settings
          </button>
        </div>
      </header>

      <main className="editor">
        <aside className="sidebar left-panel">
          <div className="panel-header">
            <div>
              <div className="panel-title">Photos</div>
              <div className="panel-subtitle">0 photos</div>
            </div>

            <button className="add-button">+ Add</button>
          </div>

          <div className="photo-list">
            <div className="empty-state">
              <div className="empty-icon">＋</div>
              <div className="empty-title">No photos yet</div>
              <div className="empty-text">
                Add photos to start creating your Polaroid.
              </div>
            </div>
          </div>
        </aside>

        <section className="workspace">
          <div className="workspace-toolbar">
            <div className="workspace-title">Untitled Project</div>

            <div className="workspace-actions">
              <button className="small-button">Undo</button>
              <button className="small-button">Redo</button>
            </div>
          </div>

          <div className="canvas-area">
            <div className="canvas">
              <div className="canvas-placeholder">
                <div className="polaroid-preview">
                  <div className="polaroid-photo">
                    <span>Photo</span>
                  </div>
                  <div className="polaroid-caption">POLAROID</div>
                </div>
              </div>
            </div>
          </div>

          <div className="bottom-bar">
            <button className="zoom-button">−</button>

            <div className="zoom-slider">
              <div className="zoom-track">
                <div className="zoom-progress" />
                <div className="zoom-knob" />
              </div>
            </div>

            <button className="zoom-button">+</button>

            <div className="zoom-value">100%</div>

            <div className="bottom-divider" />

            <button className="fit-button">Fit</button>
          </div>
        </section>

        <aside className="sidebar right-panel">
          <div className="panel-header">
            <div>
              <div className="panel-title">Properties</div>
              <div className="panel-subtitle">No selection</div>
            </div>
          </div>

          <div className="properties">
            <div className="property-section">
              <div className="section-title">Position</div>

              <div className="property-grid">
                <div className="property-field">
                  <label>X</label>
                  <input type="text" value="0" readOnly />
                </div>

                <div className="property-field">
                  <label>Y</label>
                  <input type="text" value="0" readOnly />
                </div>
              </div>
            </div>

            <div className="property-section">
              <div className="section-title">Size</div>

              <div className="property-grid">
                <div className="property-field">
                  <label>Width</label>
                  <input type="text" value="0" readOnly />
                </div>

                <div className="property-field">
                  <label>Height</label>
                  <input type="text" value="0" readOnly />
                </div>
              </div>
            </div>

            <div className="property-section">
              <div className="section-title">Transform</div>

              <div className="property-field full-width">
                <label>Rotation</label>
                <input type="text" value="0°" readOnly />
              </div>
            </div>

            <div className="property-section">
              <div className="section-title">Polaroid</div>

              <div className="property-field full-width">
                <label>Template</label>
                <select defaultValue="classic">
                  <option value="classic">Classic</option>
                </select>
              </div>
            </div>
          </div>
        </aside>
      </main>
    </div>
  )
}

export default App
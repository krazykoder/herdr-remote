# Spec: Static Conversation Composer Bubble & Floating Working Badges

## 1. Objective
Enhance the Conversation View UI in `herdr-remote`:
1. **Floating Working Badges**: Display prominent floating badges in the top-left corner of the conversation view for all active/working agents in the current conversation (`Working … [agent name] [agent badge]`).
2. **Static Composer Bubble**: Ensure the composer bubble (`.conv-dock` / `#convBubble`) remains static at the bottom of the conversation view and never rubber-bands or shifts during momentum scroll or overscroll of the bubbles thread.

---

## 2. UI Specifications

### Floating Working Badges
- **Placement**: Top-left corner of the conversation thread (`top: 6px; left: 12px;` in `#termWrap` and `top: 100%; margin-top: 6px; left: 12px;` in `.conv-view-top`).
- **Format**:
  ```html
  <div class="conv-working-chip">
    <span class="conv-working-dot" aria-hidden="true"></span>
    <span>Working … <strong>[Agent Name]</strong></span>
    <span class="badge">[harness]</span>
  </div>
  ```
- **Lifecycle**: Automatically populated and rendered whenever conversation members transition to `status === 'working'` or `agent_status === 'working'`. Emptied when no members are active or when navigating away.

### Static Composer Bubble
- **Structural Separation**:
  ```html
  <div class="view" id="convView">
    <div class="conv-view-top" id="convViewTop">...</div>
    <div class="conv-wrap" id="convWrap">
      <div class="conv-thread" id="convViewThread"></div>
      <button class="hang-btn hang-last hang-corner" id="convLast">↓ Last</button>
    </div>
    <div class="conv-dock" id="convDock">
      <div class="conv-bubble" id="convBubble">...</div>
    </div>
  </div>
  ```
- **Scroll Model**:
  - `#convView`: `overflow: hidden; height: 100%; display: flex; flex-direction: column;`
  - `.conv-wrap`: `position: relative; flex: 1; min-height: 0; display: flex; overflow: hidden;`
  - `#convViewThread`: `flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; -webkit-overflow-scrolling: touch;`
  - `.conv-dock`: `flex-shrink: 0; position: relative; z-index: 3; background: var(--bg);` (static flex item at the bottom of `#convView`).

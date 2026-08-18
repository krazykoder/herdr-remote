# Decision Log: Static Conversation Composer Bubble & Floating Working Badges

## Decision
1. Introduce floating working status badges in the top-left corner of the conversation thread view.
2. Refactor `#convView` to decouple the scroll container from the composer footer, isolating scroll momentum and rubber-banding to `#convViewThread`.

## Rationale
- **Working Visibility**: In joint multi-pane or backgrounded conversations, users need immediate visual awareness of which agents are currently thinking or executing without opening the roster panel.
- **Scroll Isolation**: Rubber-banding the entire view caused the composer to jump with every momentum scroll, giving a destabilized feel against the static app shell. Isolating `#convViewThread` inside `.conv-wrap` keeps the composer firmly anchored at the bottom, matching the behavior of modern messaging interfaces.

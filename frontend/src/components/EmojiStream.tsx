import type { FC } from 'react';

export interface EmojiBubble {
  id: string;
  emoji: string;
  label: string;
  player: string;
}

interface EmojiStreamProps {
  effects: EmojiBubble[];
}

const EmojiStream: FC<EmojiStreamProps> = ({ effects }) => {
  if (!effects.length) {
    return null;
  }
  return (
    <div className="Session-effectsStream" aria-live="polite">
      {effects.map((effect) => (
        <div key={effect.id} className="Session-effectBubble">
          <span className="Session-effectEmoji" aria-hidden="true">
            {effect.emoji}
          </span>
          <div className="Session-effectText">
            <strong>{effect.player}</strong>
            <span>{effect.label}</span>
          </div>
        </div>
      ))}
    </div>
  );
};

export default EmojiStream;

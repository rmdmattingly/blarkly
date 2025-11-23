import type React from 'react';
import type { Card } from '../api/highlow';
import type { OldMaidPlayer, OldMaidStatus } from '../api/oldmaid';
import type { EmojiEffectKey } from '../constants/emoji';

interface OldMaidTableProps {
  players: OldMaidPlayer[];
  localPlayerName: string | null;
  currentTurnIndex: number;
  status: OldMaidStatus;
  activeDrawer?: OldMaidPlayer | null;
  drawTarget?: OldMaidPlayer | null;
  drawMode?: 'offense' | 'defense' | null;
  offenseCardCount?: number;
  offenseSlots?: number | null;
  offenseSelectionIndex?: number | null;
  offenseDisabled?: boolean;
  onSelectCard?: (index: number) => void;
  offenseReveal?: { card?: Card; matched?: boolean; phase?: 'preview' | 'show' } | null;
  defenseHand?: Card[];
  defenseHighlight?: string | null;
  defenseActorName?: string | null;
  loserName?: string | null;
  pairFlash?: { playerName: string; cards: Card[] } | null;
  recentDraw?: { from?: string; cardLabel?: string; matched?: boolean; visible?: boolean } | null;
  recentTheft?: { cardLabel: string; by?: string; visible?: boolean; targetId?: string; phase?: 'preview' | 'show' } | null;
  offenseContext?: { actor: string; target: string; targetId?: string } | null;
  centerOverlay?: {
    title: string;
    description?: string;
    actionLabel?: string;
    actionDisabled?: boolean;
    onAction?: () => void;
  } | null;
  reactionEmojis?: Record<string, { symbol: string; startedAt: number; duration: number }>;
  localHand?: Array<{ key: string; card: Card }>;
  onPromoteCard?: (key: string) => void;
  onShuffleLocalHand?: () => void;
  onSendEmoji?: (emojiId: EmojiEffectKey) => void;
  emojiError?: string | null;
}

const OldMaidTable = ({
  players,
  localPlayerName,
  currentTurnIndex,
  status,
  activeDrawer,
  drawTarget,
  drawMode,
  offenseCardCount = 0,
  offenseSlots = null,
  offenseSelectionIndex = null,
  offenseDisabled = false,
  onSelectCard,
  offenseReveal,
  defenseHand,
  defenseHighlight,
  defenseActorName,
  loserName,
  pairFlash,
  recentDraw,
  recentTheft,
  offenseContext,
  centerOverlay,
  reactionEmojis = {},
  localHand = [],
  onPromoteCard,
  onShuffleLocalHand,
  onSendEmoji,
  emojiError,
}: OldMaidTableProps) => {
  const layout = getSeatLayout(players, localPlayerName);
  const activeName = offenseContext?.actor ?? activeDrawer?.displayName ?? activeDrawer?.name ?? 'Player';
  const targetName = offenseContext?.target ?? drawTarget?.displayName ?? drawTarget?.name ?? 'player';
  const highlightedTargetName = offenseContext?.targetId ?? drawTarget?.name ?? null;
  const totalOffenseCards = Math.max(0, offenseSlots ?? offenseCardCount ?? 0);

  return (
    <div className="OldMaid-tableWrapper">
      <div className="OldMaid-table">
        {layout.map((seat) => {
          const reactionInfo = seat.player ? reactionEmojis[seat.player.name] : undefined;
          const reactionEmoji = reactionInfo?.symbol;
          const reactionDuration = reactionInfo?.duration ?? 0;
          return (
            <div
              key={seat.id}
              className={[
                'OldMaid-seat',
                seat.player?.isOnline ? 'online' : 'offline',
                isTurn(players, seat.player, currentTurnIndex) ? 'turn' : '',
                seat.player && highlightedTargetName === seat.player.name ? 'target' : '',
                pairFlash && seat.player?.name === pairFlash.playerName ? 'pair-flash' : '',
                seat.player && recentTheft?.visible && seat.player.name === recentTheft.targetId ? 'was-targeted' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              style={{ left: `${seat.x}%`, top: `${seat.y}%` }}
            >
              {seat.player ? (
                <>
                  <div
                    className={`OldMaid-avatarIcon ${seat.player.isOnline ? 'online' : 'offline'} ${reactionEmoji ? 'has-reaction' : ''}`}
                    aria-hidden="true"
                    style={
                      reactionEmoji
                        ? ({ '--reaction-duration': `${Math.max(reactionDuration, 0)}ms` } as React.CSSProperties)
                        : undefined
                    }
                  >
                    <span className="OldMaid-avatarEmoji">
                      {reactionEmoji
                        ? reactionEmoji
                        : status === 'complete' && loserName === seat.player.name
                          ? '👵'
                          : seat.player.isSafe
                            ? '😌'
                            : seat.player.name === localPlayerName
                              ? '🙂'
                              : '🧑'}
                    </span>
                    {reactionEmoji ? <span className="OldMaid-reactionRing" aria-hidden="true" /> : null}
                  </div>
                  <div className="OldMaid-seatName">
                    {seat.player.displayName ?? seat.player.name}
                    {seat.player.name === localPlayerName ? ' (you)' : ''}
                  </div>
                  {seat.player.name !== localPlayerName ? (
                  <div className="OldMaid-seatCount">
                    {seat.player.hand.length
                      ? seat.player.hand.map((_, idx) => <span key={`${seat.player.name}-count-${idx}`}>🂠</span>)
                      : <span>—</span>}
                  </div>
                  ) : null}
                  {seat.player.isSafe ? <span className="OldMaid-safeBadge">Safe</span> : null}
                  {pairFlash && seat.player.name === pairFlash.playerName ? (
                    <div className="OldMaid-pairToast">
                      <span>{pairFlash.cards.map((card) => card.label).join(' ')}</span>
                      <small>Pair removed</small>
                    </div>
                  ) : null}
                  {seat.player && recentTheft?.visible && seat.player.name === recentTheft.targetId ? (
                    <div className="OldMaid-defenseToast">
                      <span>{recentTheft.cardLabel}</span>
                      <small>Taken by {recentTheft.by ?? 'opponent'}</small>
                    </div>
                  ) : null}
                </>
              ) : (
                <div className="OldMaid-seatEmpty">Waiting…</div>
              )}
            </div>
          );
        })}

        <div className="OldMaid-tableCenter">
          {drawMode === 'offense' ? (
            <div className="OldMaid-centerPanel mode-offense">
              <p>
                Drawing from <strong>{targetName}</strong>
              </p>
              <div className="OldMaid-centerCards">
                {totalOffenseCards > 0
                  ? Array.from({ length: totalOffenseCards }).map((_, idx) => {
                      const isChosen = offenseSelectionIndex === idx;
                      const isFlipped = isChosen && offenseReveal?.phase === 'show';
                      const locked = offenseSelectionIndex !== null && offenseSelectionIndex !== idx;
                      const canSelect = Boolean(onSelectCard) && offenseSelectionIndex === null && !offenseDisabled;
                      const frontLabel =
                        isChosen && offenseReveal?.card?.label && offenseReveal.phase === 'show'
                          ? offenseReveal.card.label
                          : '🂠';
                      const handleClick = () => {
                        if (!canSelect || !onSelectCard) {
                          return;
                        }
                        onSelectCard(idx);
                      };
                      return (
                        <button
                          key={`offense-${idx}`}
                          type="button"
                          className={[
                            'OldMaid-centerCardButton',
                            isChosen ? 'is-selected' : '',
                            isFlipped ? 'is-flipped' : '',
                            locked ? 'is-locked' : '',
                            !canSelect ? 'is-static' : '',
                          ]
                            .filter(Boolean)
                            .join(' ')}
                          onClick={handleClick}
                          tabIndex={canSelect ? 0 : -1}
                          aria-disabled={!canSelect}
                        >
                          <span className="OldMaid-cardInner">
                            <span className="OldMaid-cardFace is-back" aria-hidden="true">
                              🂠
                            </span>
                            <span className="OldMaid-cardFace is-front">{frontLabel}</span>
                          </span>
                        </button>
                      );
                    })
                  : (
                    <div className="OldMaid-centerCardPlaceholder" aria-hidden="true">
                      🂠
                    </div>
                  )}
              </div>
              {offenseReveal ? (
                <div className={`OldMaid-centerReveal ${offenseReveal.phase === 'show' ? 'is-visible' : 'is-hidden'}`}>
                  <span>{offenseReveal.phase === 'show' && offenseReveal.card?.label ? offenseReveal.card.label : '🂠'}</span>
                  <small>
                    {offenseReveal.phase === 'show'
                      ? offenseReveal.matched
                        ? 'Pair matched!'
                        : 'Added to your hand'
                      : 'Peeking…'}
                  </small>
                </div>
              ) : (
                <small>{onSelectCard ? 'Tap a card to pull it.' : 'Waiting for the draw…'}</small>
              )}
            </div>
          ) : drawMode === 'defense' ? (
            <div className="OldMaid-centerPanel mode-defense">
              <p>
                <strong>{defenseActorName ?? activeName}</strong> is drawing from you
              </p>
              <div className="OldMaid-centerCards defense">
                {defenseHand?.length ? (
                  defenseHand.map((card, idx) => (
                    <div
                      key={`defense-${card.label}-${idx}`}
                      className={[
                        'OldMaid-centerDefenseCard',
                        defenseHighlight === card.label ? 'is-selected' : '',
                        defenseHighlight === card.label && recentTheft?.visible ? 'is-removed' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                    >
                      {card.label}
                    </div>
                  ))
                ) : (
                  <p className="OldMaid-centerHint">No cards remaining.</p>
                )}
              </div>
              {recentTheft ? (
                <div className={`OldMaid-defenseReveal ${recentTheft.phase === 'show' ? 'is-visible' : ''}`}>
                  <div
                    className={[
                      'OldMaid-defenseRevealCard',
                      recentTheft.phase === 'show' ? 'is-flipped' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                  >
                    <span className="OldMaid-defenseCardInner">
                      <span className="OldMaid-defenseCardFace is-back" aria-hidden="true">
                        🂠
                      </span>
                      <span className="OldMaid-defenseCardFace is-front">{recentTheft.cardLabel}</span>
                    </span>
                  </div>
                  <small className="OldMaid-centerHint">
                    {recentTheft.phase === 'show'
                      ? `${recentTheft.cardLabel} went to ${recentTheft.by ?? 'your opponent'}`
                      : 'Revealing the card…'}
                  </small>
                </div>
              ) : defenseHighlight ? (
                <small className="OldMaid-centerHint">{defenseHighlight} was taken.</small>
              ) : (
                <small className="OldMaid-centerHint">Stay ready…</small>
              )}
            </div>
          ) : (
            <p className="OldMaid-tableStatus">
              {status === 'active'
                ? `${activeName} is drawing from ${targetName}`
                : ''}
            </p>
          )}
        </div>
        {centerOverlay ? (
          <div className="OldMaid-overlay">
            <h3>{centerOverlay.title}</h3>
            {centerOverlay.description ? <p>{centerOverlay.description}</p> : null}
            {centerOverlay.actionLabel ? (
              <button type="button" className="OldMaid-overlayBtn" disabled={centerOverlay.actionDisabled} onClick={centerOverlay.onAction}>
                {centerOverlay.actionLabel}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
};

const getSeatLayout = (players: OldMaidPlayer[], localPlayerName: string | null) => {
  const ordered = [...players];
  const localIndex = ordered.findIndex((player) => player.name === localPlayerName);
  if (localIndex > 0) {
    ordered.push(...ordered.splice(0, localIndex));
  }
  const count = Math.max(2, ordered.length);
  const radius = 38;
  return Array.from({ length: count }).map((_, index) => {
    const angle = (index / count) * 2 * Math.PI - Math.PI / 2;
    const x = 50 + radius * Math.cos(angle);
    const y = 50 + radius * Math.sin(angle);
    return {
      id: `seat-${index}`,
      player: ordered[index] ?? null,
      x,
      y,
    };
  });
};

const isTurn = (players: OldMaidPlayer[], seatPlayer: OldMaidPlayer | null, turnIndex: number): boolean => {
  if (!seatPlayer) {
    return false;
  }
  return players[turnIndex]?.name === seatPlayer.name;
};

export default OldMaidTable;

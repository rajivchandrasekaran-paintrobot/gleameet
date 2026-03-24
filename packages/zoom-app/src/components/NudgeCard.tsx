import React, { useEffect } from 'react';

interface NudgeCardProps {
  promptId: string;
  shortText: string;
  rationaleText: string;
  examplePhrase?: string;
  onDismiss: (promptId: string) => void;
}

export const NudgeCard: React.FC<NudgeCardProps> = ({
  promptId,
  shortText,
  rationaleText,
  examplePhrase,
  onDismiss,
}) => {
  useEffect(() => {
    const timer = setTimeout(() => onDismiss(promptId), 15000);
    return () => clearTimeout(timer);
  }, [promptId, onDismiss]);

  return (
    <div className="nudge-card">
      <div className="nudge-header">
        <span className="nudge-label">Coach</span>
        <button
          className="nudge-dismiss"
          onClick={() => onDismiss(promptId)}
          aria-label="Dismiss"
        >
          &times;
        </button>
      </div>
      <div className="nudge-text">{shortText}</div>
      {rationaleText && (
        <div className="nudge-rationale">{rationaleText}</div>
      )}
      {examplePhrase && (
        <div className="nudge-example">Try: "{examplePhrase}"</div>
      )}
    </div>
  );
};

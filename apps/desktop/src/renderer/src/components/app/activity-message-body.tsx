import { ActivityRichText } from "../ui/activity-rich-text";
import { GitDiffPreview } from "./git-diff-preview";
import { looksLikeGitDiff } from "./git-diff-utils";

/**
 * Renders assistant/user-style activity text as Markdown, or as a structured git diff when content looks like a unified diff.
 */
export const ActivityMarkdownOrGitDiff = ({
  content,
  className,
  compact = false,
}: {
  content: string;
  className?: string;
  compact?: boolean;
}) => {
  if (looksLikeGitDiff(content)) {
    return (
      <div className={className}>
        <GitDiffPreview
          diffText={content}
          emptyMessage="No diff available."
          compact={compact}
          viewType="unified"
          activityEmphasis
        />
      </div>
    );
  }

  return <ActivityRichText content={content} className={className} compact={compact} />;
};

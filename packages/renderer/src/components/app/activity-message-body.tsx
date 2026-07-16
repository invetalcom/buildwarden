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
  onOpenWorkspaceFile,
}: {
  content: string;
  className?: string;
  compact?: boolean;
  onOpenWorkspaceFile?: (path: string) => void;
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
          onOpenFile={onOpenWorkspaceFile}
        />
      </div>
    );
  }

  return <ActivityRichText content={content} className={className} compact={compact} onOpenWorkspaceFile={onOpenWorkspaceFile} />;
};

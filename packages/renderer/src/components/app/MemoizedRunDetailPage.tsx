import { memo } from "react";
import { useShallowStableValue, useStableFunctionProps } from "../../lib/use-stable-function-props";
import { RunDetailPage, type RunDetailPageProps } from "./RunDetailPage";

const MemoRunDetailPage = memo(RunDetailPage);

/**
 * RunDetailPage re-renders the whole run workspace (timeline, diff, terminal,
 * composer). App passes inline handlers and a freshly computed token usage on
 * every render; stabilize both so unrelated App state changes (busy, toasts,
 * sidebar, snapshot refreshes) skip the run page.
 */
export const MemoizedRunDetailPage = (props: RunDetailPageProps) => {
  const stableProps = useStableFunctionProps(props);
  const tokenUsage = useShallowStableValue(props.tokenUsage);
  return <MemoRunDetailPage {...stableProps} tokenUsage={tokenUsage} />;
};

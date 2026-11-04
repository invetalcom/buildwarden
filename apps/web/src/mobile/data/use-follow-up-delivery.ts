import {
  APP_SETTING_KEYS,
  parseFollowUpDeliverySetting,
  providerSupportsFollowUpSteering,
  resolveFollowUpDelivery,
  type FollowUpDelivery,
  type ProviderType,
} from "@buildwarden/shared";
import { useMobileApp } from "./mobile-app-context";

/**
 * How a follow-up is delivered from a mobile composer. Messages queue while a turn runs or
 * entries are held; the browser's delivery preference picks queue or steer for the send button.
 */
export const useFollowUpDelivery = ({ active, queueLength, providerType }: {
  active: boolean;
  queueLength: number;
  providerType: ProviderType | undefined;
}): {
  queues: boolean;
  steeringAvailable: boolean;
  primary: FollowUpDelivery;
  activeDelivery: { primary: FollowUpDelivery; alternate?: FollowUpDelivery } | undefined;
} => {
  const { snapshot } = useMobileApp();
  const preference = parseFollowUpDeliverySetting(snapshot.settings[APP_SETTING_KEYS.followUpDelivery]);
  const steeringAvailable = active && providerSupportsFollowUpSteering(providerType);
  const primary = resolveFollowUpDelivery(preference, steeringAvailable);
  return {
    queues: active || queueLength > 0,
    steeringAvailable,
    primary,
    activeDelivery: active
      ? { primary, ...(steeringAvailable ? { alternate: resolveFollowUpDelivery(preference, steeringAvailable, true) } : {}) }
      : undefined,
  };
};

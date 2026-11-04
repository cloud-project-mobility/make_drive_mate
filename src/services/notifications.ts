import { Platform } from 'react-native';
import { departureAt } from '../domain/helpers';
import type { ActionResult, TripPlan } from '../domain/types';
import { createDepartureNotificationCoordinator } from '../domain/departureNotifications';

export async function initializeDepartureNotifications(): Promise<void> {
  if (Platform.OS === 'web') return;
  const Notifications = await import('expo-notifications');
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
}

export async function listScheduledDepartures(): Promise<{ planId: string; identifier: string }[]> {
  if (Platform.OS === 'web') return [];
  const Notifications = await import('expo-notifications');
  const notifications = await Notifications.getAllScheduledNotificationsAsync();
  return notifications.flatMap((notification) =>
    typeof notification.content.data?.planId === 'string'
      ? [{ planId: notification.content.data.planId, identifier: notification.identifier }]
      : [],
  );
}

async function settleCancellations(operations: Promise<unknown>[]): Promise<void> {
  // A failed cancellation cannot release the queue while another native write
  // could still remove a later request with the same deterministic identifier.
  const results = await Promise.allSettled(operations);
  const failed = results.find((result) => result.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
}

async function performCancel(planId: string): Promise<void> {
  if (Platform.OS === 'web') return;
  const Notifications = await import('expo-notifications');
  const scheduled = await listScheduledDepartures();
  await settleCancellations(
    scheduled
      .filter((item) => item.planId === planId)
      .map((item) => Notifications.cancelScheduledNotificationAsync(item.identifier)),
  );
}

async function performCancelAll(): Promise<void> {
  if (Platform.OS === 'web') return;
  const Notifications = await import('expo-notifications');
  const scheduled = await listScheduledDepartures();
  await settleCancellations(
    scheduled.map((item) => Notifications.cancelScheduledNotificationAsync(item.identifier)),
  );
}

/** Called only after an explicit tap; requesting a plan never requests permissions by itself. */
async function performSchedule(plan: TripPlan): Promise<ActionResult & { identifier?: string }> {
  if (Platform.OS === 'web')
    return {
      ok: false,
      error:
        '출발 알림은 iOS·Android 앱에서 사용할 수 있어요. 웹에서는 권장 출발 시간을 확인해 주세요.',
    };
  const at = departureAt(plan);
  if (!at || at.getTime() <= Date.now())
    return {
      ok: false,
      error:
        '출발 시간이 이미 지났거나 일정 시간이 없어요. 미래의 일정으로 새 계획을 만들어 주세요.',
    };
  try {
    const Notifications = await import('expo-notifications');
    if (Platform.OS === 'android')
      await Notifications.setNotificationChannelAsync('departures', {
        name: '출발 알림',
        importance: Notifications.AndroidImportance.DEFAULT,
      });
    let permission = await Notifications.getPermissionsAsync();
    if (!permission.granted) permission = await Notifications.requestPermissionsAsync();
    if (!permission.granted)
      return {
        ok: false,
        error: '알림 권한이 꺼져 있어요. 기기 설정에서 알림을 허용한 뒤 다시 시도해 주세요.',
      };
    await initializeDepartureNotifications();
    // Permission dialogs and native setup may outlast the planned departure.
    if (at.getTime() <= Date.now())
      return {
        ok: false,
        error: '알림을 준비하는 동안 출발 시간이 지났어요. 이동 계획을 확인해 주세요.',
      };
    // A deterministic identifier replaces this plan's prior request without deleting a working alarm first.
    const identifier = await Notifications.scheduleNotificationAsync({
      identifier: `departure-${plan.id}`,
      content: {
        title: `${plan.eventTitle ?? plan.destination}에 맞춰 출발하세요`,
        body: `차량 ${plan.driveMinutes}분 · 주차 후 도보 ${plan.walkMinutes}분 · 여유 ${plan.bufferMinutes}분`,
        data: { planId: plan.id },
        sound: 'default',
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        date: at,
        channelId: 'departures',
      },
    });
    return { ok: true, identifier };
  } catch {
    return {
      ok: false,
      error: '기기에 출발 알림을 등록하지 못했어요. 앱의 알림 권한과 기기 설정을 확인해 주세요.',
    };
  }
}

const coordinator = createDepartureNotificationCoordinator({
  schedule: performSchedule,
  cancel: performCancel,
  cancelAll: performCancelAll,
});

/** Await before deleting a plan or its vehicle; failed cancellation must block deletion. */
export const cancelDeparture = coordinator.cancel;

/** Also waits for pending schedules; await before restoring or resetting all local data. */
export const cancelAllDepartures = coordinator.cancelAll;

/** Called only after an explicit tap; no startup permission request. */
export const scheduleDeparture = coordinator.schedule;

import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: false,
    shouldShowList: false,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

export async function registerForNotifications(): Promise<string> {
  if (!Device.isDevice) throw new Error('Push notifications require a physical device.');
  const current = await Notifications.getPermissionsAsync();
  const permission = current.granted ? current : await Notifications.requestPermissionsAsync();
  if (!permission.granted) throw new Error('Notification permission was not granted.');

  await Notifications.setNotificationChannelAsync('messages', {
    name: 'Messages and calls',
    importance: Notifications.AndroidImportance.HIGH,
    vibrationPattern: [0, 250, 200, 250],
    sound: 'default',
  });

  const projectId = process.env.EXPO_PUBLIC_EAS_PROJECT_ID;
  if (!projectId) throw new Error('Add EXPO_PUBLIC_EAS_PROJECT_ID to apps/mobile/.env to enable push delivery.');
  return (await Notifications.getExpoPushTokenAsync({ projectId })).data;
}

export function showBrowserMessageNotification(_title: string, _body: string) {}

export function addNotificationResponseListener(callback: (data: Record<string, unknown>) => void) {
  const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
    const data = response.notification.request.content.data;
    if (data && typeof data === 'object') callback(data as Record<string, unknown>);
  });
  return () => subscription.remove();
}

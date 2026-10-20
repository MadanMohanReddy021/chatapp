export async function registerForNotifications(): Promise<string> {
  if (!('Notification' in window)) throw new Error('This browser does not support notifications.');
  const permission = await window.Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notification permission was not granted.');
  return 'browser-local';
}

export function showBrowserMessageNotification(title: string, body: string) {
  if (!document.hidden || !('Notification' in window) || window.Notification.permission !== 'granted') return;
  const notification = new window.Notification(title, { body });
  notification.onclick = () => { window.focus(); notification.close(); };
}

export function addNotificationResponseListener(_callback: (data: Record<string, unknown>) => void) {
  return () => {};
}

import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.ciphertalk.todo',
  appName: 'Notewake',
  webDir: 'dist',
  server: { androidScheme: 'https' },
  plugins: {
    LocalNotifications: {
      smallIcon: 'ic_stat_notewake',
      iconColor: '#173E35',
      presentationOptions: ['badge', 'sound', 'banner', 'list'],
    },
  },
}

export default config

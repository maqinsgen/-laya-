package com.ciphertalk.todo;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.app.WallpaperManager;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Build;
import java.io.File;
import java.io.IOException;
import java.text.SimpleDateFormat;
import java.util.Calendar;
import java.util.Locale;

final class CipherWallpaperSchedule {
    static final String ACTION_APPLY = "com.ciphertalk.todo.APPLY_DAILY_WALLPAPER";
    private static final int REQUEST_CODE = 47291;

    private CipherWallpaperSchedule() {}

    static File directory(Context context) {
        File directory = new File(context.getFilesDir(), "scheduled-wallpapers");
        if (!directory.exists()) directory.mkdirs();
        return directory;
    }

    static String localDayKey() {
        return new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(Calendar.getInstance().getTime());
    }

    static boolean applyToday(Context context) throws IOException {
        File file = new File(directory(context), "ciphertalk-" + localDayKey() + ".png");
        if (!file.isFile()) return false;
        Bitmap bitmap = BitmapFactory.decodeFile(file.getAbsolutePath());
        if (bitmap == null) throw new IOException("无法解码今日壁纸");
        try {
            WallpaperManager manager = WallpaperManager.getInstance(context);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                manager.setBitmap(bitmap, null, true, WallpaperManager.FLAG_SYSTEM);
            } else {
                manager.setBitmap(bitmap);
            }
        } finally {
            bitmap.recycle();
        }
        return true;
    }

    static void scheduleNext(Context context) {
        Calendar next = Calendar.getInstance();
        next.add(Calendar.DAY_OF_YEAR, 1);
        next.set(Calendar.HOUR_OF_DAY, 0);
        next.set(Calendar.MINUTE, 10);
        next.set(Calendar.SECOND, 0);
        next.set(Calendar.MILLISECOND, 0);

        Intent intent = new Intent(context, CipherWallpaperReceiver.class).setAction(ACTION_APPLY);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent pendingIntent = PendingIntent.getBroadcast(context, REQUEST_CODE, intent, flags);
        AlarmManager manager = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (manager == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, next.getTimeInMillis(), pendingIntent);
        } else {
            manager.set(AlarmManager.RTC_WAKEUP, next.getTimeInMillis(), pendingIntent);
        }
    }
}

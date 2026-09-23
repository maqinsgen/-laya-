package com.ciphertalk.todo;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public class CipherWallpaperReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        try {
            CipherWallpaperSchedule.applyToday(context);
        } catch (Exception ignored) {
            // 下次启动应用会再次准备并应用；广播不能因单张图片失败而崩溃。
        } finally {
            CipherWallpaperSchedule.scheduleNext(context);
        }
    }
}

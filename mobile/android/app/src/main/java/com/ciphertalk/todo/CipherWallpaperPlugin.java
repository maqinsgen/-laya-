package com.ciphertalk.todo;

import android.app.WallpaperManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Build;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.JSArray;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.IOException;
import java.io.File;
import java.io.FileOutputStream;
import java.util.HashSet;
import java.util.Set;
import org.json.JSONObject;

@CapacitorPlugin(name = "CipherWallpaper")
public class CipherWallpaperPlugin extends Plugin {
    private static final int MAX_SCHEDULED_WALLPAPERS = 8;
    private static final int MAX_WALLPAPER_BYTES = 12 * 1024 * 1024;

    @PluginMethod
    public void setWallpaper(PluginCall call) {
        String encoded = call.getString("base64");
        if (encoded == null || encoded.length() == 0) {
            call.reject("壁纸数据为空");
            return;
        }
        try {
            byte[] bytes = Base64.decode(encoded, Base64.DEFAULT);
            Bitmap bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
            if (bitmap == null) {
                call.reject("无法解码壁纸图片");
                return;
            }
            WallpaperManager manager = WallpaperManager.getInstance(getContext());
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                manager.setBitmap(bitmap, null, true, WallpaperManager.FLAG_SYSTEM);
            } else {
                manager.setBitmap(bitmap);
            }
            bitmap.recycle();
            call.resolve(new JSObject());
        } catch (IllegalArgumentException | IOException error) {
            call.reject("应用壁纸失败", error);
        }
    }

    @PluginMethod
    public void scheduleWallpapers(PluginCall call) {
        JSArray entries = call.getArray("entries");
        if (entries == null || entries.length() == 0 || entries.length() > MAX_SCHEDULED_WALLPAPERS) {
            call.reject("壁纸计划必须包含 1 到 8 天");
            return;
        }
        File directory = CipherWallpaperSchedule.directory(getContext());
        Set<String> expectedFiles = new HashSet<>();
        try {
            for (int index = 0; index < entries.length(); index++) {
                JSONObject entry = entries.getJSONObject(index);
                String dayKey = entry.optString("dayKey", "");
                String encoded = entry.optString("base64", "");
                if (!dayKey.matches("\\d{4}-\\d{2}-\\d{2}")) throw new IOException("壁纸日期无效");
                byte[] bytes = Base64.decode(encoded, Base64.DEFAULT);
                if (bytes.length == 0 || bytes.length > MAX_WALLPAPER_BYTES) throw new IOException("壁纸图片大小无效");
                String fileName = "ciphertalk-" + dayKey + ".png";
                expectedFiles.add(fileName);
                try (FileOutputStream output = new FileOutputStream(new File(directory, fileName))) {
                    output.write(bytes);
                }
            }
            File[] existing = directory.listFiles();
            if (existing != null) {
                for (File file : existing) {
                    if (file.getName().startsWith("ciphertalk-") && file.getName().endsWith(".png") && !expectedFiles.contains(file.getName())) {
                        file.delete();
                    }
                }
            }
            if (!CipherWallpaperSchedule.applyToday(getContext())) throw new IOException("计划中缺少今日壁纸");
            CipherWallpaperSchedule.scheduleNext(getContext());
            call.resolve(new JSObject());
        } catch (Exception error) {
            call.reject("安排每日壁纸失败", error);
        }
    }
}

package com.ciphertalk.todo;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(CipherWallpaperPlugin.class);
        super.onCreate(savedInstanceState);
    }
}

package com.gauravguleria.gongtimer;

import android.content.Intent;
import android.view.WindowManager;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "Gong")
public class GongPlugin extends Plugin {

    @PluginMethod
    public void start(PluginCall call) {
        JSArray arr = call.getArray("offsets");
        if (arr == null || arr.length() == 0) {
            call.reject("No gong times given");
            return;
        }
        long[] offsets = new long[arr.length()];
        try {
            for (int i = 0; i < offsets.length; i++) offsets[i] = arr.getLong(i);
        } catch (Exception e) {
            call.reject("Bad gong times");
            return;
        }
        float volume = (float) (call.getDouble("volume", 100.0) / 100.0);

        Intent intent = new Intent(getContext(), GongService.class);
        intent.setAction("start");
        intent.putExtra("offsets", offsets);
        intent.putExtra("volume", volume);
        ContextCompat.startForegroundService(getContext(), intent);
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        Intent intent = new Intent(getContext(), GongService.class);
        intent.setAction("stop");
        getContext().startService(intent);
        call.resolve();
    }

    @PluginMethod
    public void setVolume(PluginCall call) {
        GongService.volume = (float) (call.getDouble("volume", 100.0) / 100.0);
        call.resolve();
    }

    @PluginMethod
    public void keepAwake(PluginCall call) {
        final boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        getActivity().runOnUiThread(new Runnable() {
            @Override public void run() {
                if (on) getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                else getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            }
        });
        call.resolve();
    }
}

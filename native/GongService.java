package com.gauravguleria.gongtimer;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.MediaPlayer;
import android.media.audiofx.LoudnessEnhancer;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;

import java.util.ArrayList;
import java.util.List;

/**
 * Rings the gong at exact times even when the screen is off or the app is in the background.
 * Runs as a foreground service holding a partial wake lock for the length of the session.
 */
public class GongService extends Service {
    static final String CHANNEL = "gong_session";
    static volatile float volume = 1f;   // 1.0 = 100%, up to 3.0

    private Handler handler;
    private PowerManager.WakeLock wakeLock;
    private final List<Runnable> pending = new ArrayList<>();
    private final List<MediaPlayer> players = new ArrayList<>();
    private final List<LoudnessEnhancer> enhancers = new ArrayList<>();

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null || "stop".equals(intent.getAction())) {
            shutdown();
            return START_NOT_STICKY;
        }

        startInForeground();
        cancelAll();

        long[] offsets = intent.getLongArrayExtra("offsets");
        volume = intent.getFloatExtra("volume", 1f);
        if (offsets == null || offsets.length == 0) {
            shutdown();
            return START_NOT_STICKY;
        }

        long last = 0;
        for (long o : offsets) last = Math.max(last, o);

        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (wakeLock == null) {
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "gongtimer:session");
        }
        if (wakeLock.isHeld()) wakeLock.release();
        wakeLock.acquire(last + 90_000L);

        handler = new Handler(Looper.getMainLooper());
        final long base = SystemClock.uptimeMillis();

        for (final long off : offsets) {
            // prepare the player a little early so the strike starts exactly on time
            final MediaPlayer[] holder = new MediaPlayer[1];
            Runnable prepare = new Runnable() {
                @Override public void run() {
                    holder[0] = MediaPlayer.create(GongService.this, R.raw.gong);
                    if (holder[0] != null) players.add(holder[0]);
                }
            };
            Runnable strike = new Runnable() {
                @Override public void run() {
                    if (holder[0] == null) prepare.run();
                    play(holder[0]);
                }
            };
            pending.add(prepare);
            pending.add(strike);
            handler.postAtTime(prepare, base + Math.max(0, off - 4000));
            handler.postAtTime(strike, base + off);
        }

        Runnable end = new Runnable() {
            @Override public void run() { shutdown(); }
        };
        pending.add(end);
        handler.postAtTime(end, base + last + 25_000L);

        return START_NOT_STICKY;
    }

    private void play(MediaPlayer mp) {
        if (mp == null) return;
        try {
            float v = volume;
            if (v <= 1f) {
                mp.setVolume(v, v);
            } else {
                mp.setVolume(1f, 1f);
                try {
                    LoudnessEnhancer le = new LoudnessEnhancer(mp.getAudioSessionId());
                    le.setTargetGain((int) (2000 * Math.log10(v)));
                    le.setEnabled(true);
                    enhancers.add(le);
                } catch (Exception ignored) { /* fall back to normal volume */ }
            }
            mp.setOnCompletionListener(new MediaPlayer.OnCompletionListener() {
                @Override public void onCompletion(MediaPlayer m) {
                    m.release();
                    players.remove(m);
                }
            });
            mp.start();
        } catch (Exception ignored) { /* keep the session going */ }
    }

    private void startInForeground() {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Gong session", NotificationManager.IMPORTANCE_LOW);
            ch.setSound(null, null);
            nm.createNotificationChannel(ch);
        }
        Intent open = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent pi = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
        Notification n = b.setContentTitle("Gong Timer")
                .setContentText("Session running")
                .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
                .setContentIntent(pi)
                .setOngoing(true)
                .build();
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        } else {
            startForeground(1, n);
        }
    }

    private void cancelAll() {
        if (handler != null) {
            for (Runnable r : pending) handler.removeCallbacks(r);
        }
        pending.clear();
        releasePlayers();
    }

    private void releasePlayers() {
        for (MediaPlayer m : new ArrayList<>(players)) {
            try { m.stop(); } catch (Exception ignored) { }
            try { m.release(); } catch (Exception ignored) { }
        }
        players.clear();
        for (LoudnessEnhancer e : enhancers) {
            try { e.release(); } catch (Exception ignored) { }
        }
        enhancers.clear();
    }

    private void shutdown() {
        cancelAll();
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        stopForeground(true);
        stopSelf();
    }

    @Override
    public void onDestroy() {
        cancelAll();
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        super.onDestroy();
    }
}

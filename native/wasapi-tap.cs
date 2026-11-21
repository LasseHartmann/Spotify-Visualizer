using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace WasapiTap
{
    [StructLayout(LayoutKind.Sequential)]
    struct PropertyKey
    {
        public Guid fmtid;
        public uint pid;
    }

    [StructLayout(LayoutKind.Explicit, Size = 24)]
    struct PropVariant
    {
        [FieldOffset(0)] public ushort vt;
        [FieldOffset(8)] public IntPtr pointerValue;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    struct WaveFormatEx
    {
        public ushort wFormatTag;
        public ushort nChannels;
        public uint nSamplesPerSec;
        public uint nAvgBytesPerSec;
        public ushort nBlockAlign;
        public ushort wBitsPerSample;
        public ushort cbSize;
    }

    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    class MMDeviceEnumeratorComObject { }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator
    {
        [PreserveSig] int EnumAudioEndpoints(int dataFlow, uint dwStateMask, out IMMDeviceCollection ppDevices);
        [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppEndpoint);
        [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string pwstrId, out IMMDevice ppDevice);
        [PreserveSig] int RegisterEndpointNotificationCallback(IntPtr pClient);
        [PreserveSig] int UnregisterEndpointNotificationCallback(IntPtr pClient);
    }

    [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceCollection
    {
        [PreserveSig] int GetCount(out uint pcDevices);
        [PreserveSig] int Item(uint nDevice, out IMMDevice ppDevice);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDevice
    {
        [PreserveSig] int Activate(ref Guid iid, uint dwClsCtx, IntPtr pActivationParams, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
        [PreserveSig] int OpenPropertyStore(uint stgmAccess, out IPropertyStore ppProperties);
        [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string ppstrId);
        [PreserveSig] int GetState(out uint pdwState);
    }

    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPropertyStore
    {
        [PreserveSig] int GetCount(out uint cProps);
        [PreserveSig] int GetAt(uint iProp, out PropertyKey pkey);
        [PreserveSig] int GetValue(ref PropertyKey key, out PropVariant pv);
    }

    [ComImport, Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioClient
    {
        [PreserveSig] int Initialize(int shareMode, uint streamFlags, long hnsBufferDuration, long hnsPeriodicity, IntPtr pFormat, IntPtr audioSessionGuid);
        [PreserveSig] int GetBufferSize(out uint pNumBufferFrames);
        [PreserveSig] int GetStreamLatency(out long phnsLatency);
        [PreserveSig] int GetCurrentPadding(out uint pNumPaddingFrames);
        [PreserveSig] int IsFormatSupported(int shareMode, IntPtr pFormat, out IntPtr ppClosestMatch);
        [PreserveSig] int GetMixFormat(out IntPtr ppDeviceFormat);
        [PreserveSig] int GetDevicePeriod(out long phnsDefaultDevicePeriod, out long phnsMinimumDevicePeriod);
        [PreserveSig] int Start();
        [PreserveSig] int Stop();
        [PreserveSig] int Reset();
        [PreserveSig] int SetEventHandle(IntPtr eventHandle);
        [PreserveSig] int GetService(ref Guid riid, [MarshalAs(UnmanagedType.IUnknown)] out object ppv);
    }

    [ComImport, Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioCaptureClient
    {
        [PreserveSig] int GetBuffer(out IntPtr ppData, out uint pNumFramesToRead, out uint pdwFlags, out ulong pu64DevicePosition, out ulong pu64QPCPosition);
        [PreserveSig] int ReleaseBuffer(uint numFramesRead);
        [PreserveSig] int GetNextPacketSize(out uint pNumFramesInNextPacket);
    }

    class Program
    {
        const int eRender = 0;
        const int eConsole = 0;
        const uint DEVICE_STATE_ACTIVE = 0x00000001;
        const uint CLSCTX_ALL = 0x17;
        const int AUDCLNT_SHAREMODE_SHARED = 0;
        const uint AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000;
        const uint AUDCLNT_BUFFERFLAGS_SILENT = 0x00000002;
        const ushort WAVE_FORMAT_PCM = 1;
        const ushort WAVE_FORMAT_IEEE_FLOAT = 3;
        const ushort WAVE_FORMAT_EXTENSIBLE = 0xFFFE;
        const int FFT_SIZE = 2048;
        const int HALF_FFT = FFT_SIZE / 2;

        static Guid IID_IAudioClient = new Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2");
        static Guid IID_IAudioCaptureClient = new Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317");
        static Guid KSDATAFORMAT_SUBTYPE_IEEE_FLOAT = new Guid("00000003-0000-0010-8000-00AA00389B71");
        static Guid KSDATAFORMAT_SUBTYPE_PCM = new Guid("00000001-0000-0010-8000-00AA00389B71");
        static PropertyKey PKEY_Device_FriendlyName = new PropertyKey
        {
            fmtid = new Guid("A45C254E-DF1C-4EFD-8020-67D146A850E0"),
            pid = 14
        };

        [DllImport("ole32.dll")]
        static extern int PropVariantClear(ref PropVariant pvar);

        [DllImport("user32.dll")]
        static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

        const byte VK_MEDIA_NEXT_TRACK = 0xB0;
        const byte VK_MEDIA_PREV_TRACK = 0xB1;
        const byte VK_MEDIA_PLAY_PAUSE = 0xB3;
        const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
        const uint KEYEVENTF_KEYUP = 0x0002;

        static int SendMediaKey(string action)
        {
            byte vk;
            if (action == "playpause") vk = VK_MEDIA_PLAY_PAUSE;
            else if (action == "next") vk = VK_MEDIA_NEXT_TRACK;
            else if (action == "prev" || action == "previous") vk = VK_MEDIA_PREV_TRACK;
            else return 1;

            keybd_event(vk, 0, KEYEVENTF_EXTENDEDKEY, UIntPtr.Zero);
            Thread.Sleep(25);
            keybd_event(vk, 0, KEYEVENTF_EXTENDEDKEY | KEYEVENTF_KEYUP, UIntPtr.Zero);
            return 0;
        }

        static string GetDeviceName(IMMDevice device)
        {
            try
            {
                IPropertyStore store;
                if (device.OpenPropertyStore(0, out store) != 0 || store == null) return "Audio Output";
                PropVariant pv;
                if (store.GetValue(ref PKEY_Device_FriendlyName, out pv) == 0)
                {
                    string name = pv.vt == 31 && pv.pointerValue != IntPtr.Zero
                        ? Marshal.PtrToStringUni(pv.pointerValue)
                        : "Audio Output";
                    PropVariantClear(ref pv);
                    Marshal.ReleaseComObject(store);
                    return name ?? "Audio Output";
                }
                Marshal.ReleaseComObject(store);
            }
            catch { }
            return "Audio Output";
        }

        static string EscapeJson(string s)
        {
            if (s == null) return "";
            var sb = new StringBuilder(s.Length + 8);
            foreach (char c in s)
            {
                switch (c)
                {
                    case '\\': sb.Append("\\\\"); break;
                    case '"': sb.Append("\\\""); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 32) sb.AppendFormat("\\u{0:x4}", (int)c);
                        else sb.Append(c);
                        break;
                }
            }
            return sb.ToString();
        }

        static int ListDevices()
        {
            var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
            string defaultId = "";
            IMMDevice defDev;
            if (enumerator.GetDefaultAudioEndpoint(eRender, eConsole, out defDev) == 0 && defDev != null)
            {
                defDev.GetId(out defaultId);
                Marshal.ReleaseComObject(defDev);
            }

            IMMDeviceCollection col;
            int hr = enumerator.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, out col);
            if (hr != 0 || col == null)
            {
                Console.WriteLine("[]");
                return 0;
            }

            uint count;
            col.GetCount(out count);
            var sb = new StringBuilder();
            sb.Append('[');
            for (uint i = 0; i < count; i++)
            {
                IMMDevice dev;
                if (col.Item(i, out dev) != 0 || dev == null) continue;
                string id;
                dev.GetId(out id);
                string name = GetDeviceName(dev);
                bool isDefault = string.Equals(id, defaultId, StringComparison.OrdinalIgnoreCase);
                if (i > 0) sb.Append(',');
                sb.Append("{\"id\":\"").Append(EscapeJson(id))
                  .Append("\",\"name\":\"").Append(EscapeJson(name))
                  .Append("\",\"isDefault\":").Append(isDefault ? "true" : "false")
                  .Append('}');
                Marshal.ReleaseComObject(dev);
            }
            sb.Append(']');
            Console.OutputEncoding = Encoding.UTF8;
            Console.WriteLine(sb.ToString());
            Marshal.ReleaseComObject(col);
            Marshal.ReleaseComObject(enumerator);
            return 0;
        }

        static double[] BuildHannWindow(int n)
        {
            var win = new double[n];
            for (int i = 0; i < n; i++)
            {
                win[i] = 0.5 * (1.0 - Math.Cos(2.0 * Math.PI * i / (n - 1)));
            }
            return win;
        }

        static void FftInPlace(double[] re, double[] im)
        {
            int n = re.Length;
            int j = 0;
            for (int i = 1; i < n; i++)
            {
                int bit = n >> 1;
                while ((j & bit) != 0)
                {
                    j ^= bit;
                    bit >>= 1;
                }
                j ^= bit;
                if (i < j)
                {
                    double tr = re[i]; re[i] = re[j]; re[j] = tr;
                    double ti = im[i]; im[i] = im[j]; im[j] = ti;
                }
            }

            for (int len = 2; len <= n; len <<= 1)
            {
                double ang = -2.0 * Math.PI / len;
                double wlenRe = Math.Cos(ang);
                double wlenIm = Math.Sin(ang);
                int half = len >> 1;
                for (int i = 0; i < n; i += len)
                {
                    double wRe = 1.0;
                    double wIm = 0.0;
                    for (int k = 0; k < half; k++)
                    {
                        int uIdx = i + k;
                        int vIdx = uIdx + half;
                        double vr = re[vIdx] * wRe - im[vIdx] * wIm;
                        double vi = re[vIdx] * wIm + im[vIdx] * wRe;
                        re[vIdx] = re[uIdx] - vr;
                        im[vIdx] = im[uIdx] - vi;
                        re[uIdx] += vr;
                        im[uIdx] += vi;
                        double nextWRe = wRe * wlenRe - wIm * wlenIm;
                        wIm = wRe * wlenIm + wIm * wlenRe;
                        wRe = nextWRe;
                    }
                }
            }
        }

        static int Main(string[] args)
        {
            string requestedDeviceId = "default";
            bool diagMode = false;

            for (int i = 0; i < args.Length; i++)
            {
                if (args[i] == "--list")
                {
                    return ListDevices();
                }
                if (args[i] == "--media" && i + 1 < args.Length)
                {
                    return SendMediaKey(args[++i]);
                }
                if (args[i] == "--device" && i + 1 < args.Length)
                {
                    requestedDeviceId = args[++i];
                }
                if (args[i] == "--diag")
                {
                    diagMode = true;
                }
            }

            // Watch stdin EOF so this helper exits cleanly if the Electron parent dies
            if (!diagMode)
            {
                var watchdog = new Thread(() =>
                {
                    try
                    {
                        var buf = new byte[16];
                        var stdin = Console.OpenStandardInput();
                        while (stdin.Read(buf, 0, buf.Length) > 0) { }
                    }
                    catch { }
                    Environment.Exit(0);
                });
                watchdog.IsBackground = true;
                watchdog.Start();
            }

            var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
            var stdout = Console.OpenStandardOutput();
            var hann = BuildHannWindow(FFT_SIZE);
            var ring = new float[FFT_SIZE];
            int ringPos = 0;

            var re = new double[FFT_SIZE];
            var im = new double[FFT_SIZE];
            var smoothMag = new double[HALF_FFT];
            var packet = new byte[8 + HALF_FFT + FFT_SIZE];
            // Header magic: "SVA1"
            packet[0] = (byte)'S';
            packet[1] = (byte)'V';
            packet[2] = (byte)'A';
            packet[3] = (byte)'1';

            while (true)
            {
                IMMDevice device = null;
                IAudioClient audioClient = null;
                IAudioCaptureClient captureClient = null;
                IntPtr mixFormatPtr = IntPtr.Zero;

                try
                {
                    int hr;
                    if (string.IsNullOrEmpty(requestedDeviceId) || requestedDeviceId == "default")
                    {
                        hr = enumerator.GetDefaultAudioEndpoint(eRender, eConsole, out device);
                    }
                    else
                    {
                        hr = enumerator.GetDevice(requestedDeviceId, out device);
                        if (hr != 0 || device == null)
                        {
                            hr = enumerator.GetDefaultAudioEndpoint(eRender, eConsole, out device);
                        }
                    }

                    if (hr != 0 || device == null)
                    {
                        if (diagMode)
                        {
                            Console.Error.WriteLine("GetDefaultAudioEndpoint failed: 0x" + hr.ToString("X8"));
                            return 1;
                        }
                        Thread.Sleep(500);
                        continue;
                    }

                    string activeDeviceId;
                    device.GetId(out activeDeviceId);
                    string activeDeviceName = GetDeviceName(device);

                    object clientObj;
                    hr = device.Activate(ref IID_IAudioClient, CLSCTX_ALL, IntPtr.Zero, out clientObj);
                    if (hr != 0 || clientObj == null) throw new COMException("Activate IAudioClient failed", hr);
                    audioClient = (IAudioClient)clientObj;

                    hr = audioClient.GetMixFormat(out mixFormatPtr);
                    if (hr != 0 || mixFormatPtr == IntPtr.Zero) throw new COMException("GetMixFormat failed", hr);

                    var fmt = (WaveFormatEx)Marshal.PtrToStructure(mixFormatPtr, typeof(WaveFormatEx));
                    bool isFloat = fmt.wFormatTag == WAVE_FORMAT_IEEE_FLOAT;
                    bool isPcm = fmt.wFormatTag == WAVE_FORMAT_PCM;
                    if (fmt.wFormatTag == WAVE_FORMAT_EXTENSIBLE && fmt.cbSize >= 22)
                    {
                        var subFmtBytes = new byte[16];
                        Marshal.Copy(IntPtr.Add(mixFormatPtr, 24), subFmtBytes, 0, 16);
                        var subFmt = new Guid(subFmtBytes);
                        isFloat = subFmt == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT;
                        isPcm = subFmt == KSDATAFORMAT_SUBTYPE_PCM;
                    }

                    // 100ms buffer in 100ns units; SHARED + LOOPBACK works on 2ch, 5.1, 7.1, Dolby, Logitech G HUB, etc.
                    long bufferDuration = 1000000;
                    hr = audioClient.Initialize(
                        AUDCLNT_SHAREMODE_SHARED,
                        AUDCLNT_STREAMFLAGS_LOOPBACK,
                        bufferDuration,
                        0,
                        mixFormatPtr,
                        IntPtr.Zero
                    );
                    if (hr != 0) throw new COMException("IAudioClient.Initialize failed", hr);

                    object capObj;
                    hr = audioClient.GetService(ref IID_IAudioCaptureClient, out capObj);
                    if (hr != 0 || capObj == null) throw new COMException("GetService IAudioCaptureClient failed", hr);
                    captureClient = (IAudioCaptureClient)capObj;

                    hr = audioClient.Start();
                    if (hr != 0) throw new COMException("IAudioClient.Start failed", hr);

                    uint sampleRate = fmt.nSamplesPerSec;
                    int channels = Math.Max(1, (int)fmt.nChannels);
                    int bytesPerSample = Math.Max(1, fmt.wBitsPerSample / 8);
                    int blockAlign = Math.Max(channels * bytesPerSample, (int)fmt.nBlockAlign);

                    if (diagMode)
                    {
                        Console.WriteLine(
                            "OPEN_OK device=\"" + activeDeviceName +
                            "\" sampleRate=" + sampleRate +
                            " channels=" + channels +
                            " bits=" + fmt.wBitsPerSample +
                            " float=" + isFloat +
                            " pcm=" + isPcm
                        );
                    }

                    // Write sampleRate into packet header (little-endian uint32)
                    packet[4] = (byte)(sampleRate & 0xFF);
                    packet[5] = (byte)((sampleRate >> 8) & 0xFF);
                    packet[6] = (byte)((sampleRate >> 16) & 0xFF);
                    packet[7] = (byte)((sampleRate >> 24) & 0xFF);

                    byte[] rawBuf = new byte[65536];
                    int ticksSinceAudio = 0;
                    int ticksSinceDefaultCheck = 0;
                    int diagTicks = 0;
                    double diagPeak = 0;
                    int diagPackets = 0;

                    while (true)
                    {
                        uint packetFrames;
                        hr = captureClient.GetNextPacketSize(out packetFrames);
                        if (hr != 0) throw new COMException("GetNextPacketSize failed", hr);

                        bool gotFrames = false;

                        while (packetFrames > 0)
                        {
                            IntPtr dataPtr;
                            uint framesRead;
                            uint flags;
                            ulong devPos;
                            ulong qpcPos;

                            hr = captureClient.GetBuffer(out dataPtr, out framesRead, out flags, out devPos, out qpcPos);
                            if (hr != 0) throw new COMException("GetBuffer failed", hr);

                            gotFrames = true;
                            diagPackets++;

                            bool silent = (flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0 || dataPtr == IntPtr.Zero;
                            if (silent)
                            {
                                for (uint f = 0; f < framesRead; f++)
                                {
                                    ring[ringPos] = 0f;
                                    ringPos = (ringPos + 1) & (FFT_SIZE - 1);
                                }
                            }
                            else
                            {
                                int totalBytes = (int)(framesRead * blockAlign);
                                if (totalBytes > rawBuf.Length) rawBuf = new byte[totalBytes];
                                Marshal.Copy(dataPtr, rawBuf, 0, totalBytes);

                                for (int f = 0; f < (int)framesRead; f++)
                                {
                                    int frameOffset = f * blockAlign;
                                    double frontSum = 0.0;
                                    double surroundSum = 0.0;
                                    int frontCount = Math.Min(2, channels);
                                    for (int ch = 0; ch < channels; ch++)
                                    {
                                        int sampleOffset = frameOffset + ch * bytesPerSample;
                                        double sample = 0.0;
                                        if (isFloat && bytesPerSample == 4)
                                        {
                                            sample = BitConverter.ToSingle(rawBuf, sampleOffset);
                                        }
                                        else if (isPcm && bytesPerSample == 2)
                                        {
                                            sample = BitConverter.ToInt16(rawBuf, sampleOffset) / 32768.0;
                                        }
                                        else if (isPcm && bytesPerSample == 3)
                                        {
                                            int val = rawBuf[sampleOffset] | (rawBuf[sampleOffset + 1] << 8) | ((sbyte)rawBuf[sampleOffset + 2] << 16);
                                            sample = val / 8388608.0;
                                        }
                                        else if (isPcm && bytesPerSample == 4)
                                        {
                                            sample = BitConverter.ToInt32(rawBuf, sampleOffset) / 2147483648.0;
                                        }
                                        if (ch < frontCount) frontSum += sample;
                                        else surroundSum += sample;
                                    }

                                    // Preserves full stereo level on 5.1/7.1 virtual surround headsets while retaining LFE/surround channels
                                    double mono = (frontSum / frontCount) + surroundSum * 0.25;
                                    if (mono > 1.0) mono = 1.0;
                                    else if (mono < -1.0) mono = -1.0;
                                    if (Math.Abs(mono) > diagPeak) diagPeak = Math.Abs(mono);

                                    ring[ringPos] = (float)mono;
                                    ringPos = (ringPos + 1) & (FFT_SIZE - 1);
                                }
                            }

                            captureClient.ReleaseBuffer(framesRead);
                            hr = captureClient.GetNextPacketSize(out packetFrames);
                            if (hr != 0) throw new COMException("GetNextPacketSize failed", hr);
                        }

                        if (gotFrames)
                        {
                            ticksSinceAudio = 0;
                        }
                        else
                        {
                            // WASAPI loopback emits 0 packets during complete Windows playback silence
                            ticksSinceAudio++;
                            if (ticksSinceAudio >= 3)
                            {
                                int silenceFill = Math.Min(FFT_SIZE, (int)(sampleRate / 60));
                                for (int s = 0; s < silenceFill; s++)
                                {
                                    ring[ringPos] = 0f;
                                    ringPos = (ringPos + 1) & (FFT_SIZE - 1);
                                }
                            }
                        }

                        // Compute 2048-pt Hann-windowed FFT & pack byte arrays matching Web Audio AnalyserNode
                        for (int i = 0; i < FFT_SIZE; i++)
                        {
                            float sample = ring[(ringPos + i) & (FFT_SIZE - 1)];
                            re[i] = sample * hann[i];
                            im[i] = 0.0;

                            int waveByte = (int)Math.Round(128.0 + sample * 127.0);
                            if (waveByte < 0) waveByte = 0;
                            else if (waveByte > 255) waveByte = 255;
                            packet[8 + HALF_FFT + i] = (byte)waveByte;
                        }

                        FftInPlace(re, im);

                        // Scale to match AnalyserNode dB mapping (-92 dB .. -12 dB, smoothing = 0.52)
                        const double minDb = -92.0;
                        const double maxDb = -12.0;
                        const double invRange = 255.0 / (maxDb - minDb);
                        const double norm = 2.0 / FFT_SIZE;

                        for (int i = 0; i < HALF_FFT; i++)
                        {
                            double mag = Math.Sqrt(re[i] * re[i] + im[i] * im[i]) * norm;
                            smoothMag[i] = smoothMag[i] * 0.52 + mag * 0.48;
                            double db = smoothMag[i] > 1e-10 ? 20.0 * Math.Log10(smoothMag[i]) : minDb;
                            int b = (int)Math.Round((db - minDb) * invRange);
                            if (b < 0) b = 0;
                            else if (b > 255) b = 255;
                            packet[8 + i] = (byte)b;
                        }

                        if (diagMode)
                        {
                            diagTicks++;
                            if (diagTicks >= 40)
                            {
                                int maxFft = 0;
                                for (int i = 1; i < HALF_FFT; i++) if (packet[8 + i] > maxFft) maxFft = packet[8 + i];
                                Console.WriteLine("DIAG_RESULT packets=" + diagPackets + " peakSample=" + diagPeak.ToString("F4") + " maxFftByte=" + maxFft);
                                return 0;
                            }
                        }
                        else
                        {
                            try
                            {
                                stdout.Write(packet, 0, packet.Length);
                                stdout.Flush();
                            }
                            catch
                            {
                                return 0;
                            }
                        }

                        // Periodically verify default playback device hasn't switched (e.g. headset unplugged)
                        if (string.IsNullOrEmpty(requestedDeviceId) || requestedDeviceId == "default")
                        {
                            ticksSinceDefaultCheck++;
                            if (ticksSinceDefaultCheck >= 75)
                            {
                                ticksSinceDefaultCheck = 0;
                                IMMDevice currentDefault;
                                if (enumerator.GetDefaultAudioEndpoint(eRender, eConsole, out currentDefault) == 0 && currentDefault != null)
                                {
                                    string curId;
                                    currentDefault.GetId(out curId);
                                    Marshal.ReleaseComObject(currentDefault);
                                    if (!string.Equals(curId, activeDeviceId, StringComparison.OrdinalIgnoreCase))
                                    {
                                        break; // Re-open on newly selected Windows default output device!
                                    }
                                }
                            }
                        }

                        Thread.Sleep(16);
                    }
                }
                catch (Exception ex)
                {
                    if (diagMode)
                    {
                        Console.Error.WriteLine("DIAG_ERROR: " + ex.Message);
                        return 1;
                    }
                    Thread.Sleep(500);
                }
                finally
                {
                    if (audioClient != null)
                    {
                        try { audioClient.Stop(); } catch { }
                    }
                    if (mixFormatPtr != IntPtr.Zero) Marshal.FreeCoTaskMem(mixFormatPtr);
                    if (captureClient != null) Marshal.ReleaseComObject(captureClient);
                    if (audioClient != null) Marshal.ReleaseComObject(audioClient);
                    if (device != null) Marshal.ReleaseComObject(device);
                }
            }
        }
    }
}

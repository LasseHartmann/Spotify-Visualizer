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

    [ComImport, Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioMeterInformation
    {
        [PreserveSig] int GetPeakValue(out float pfPeak);
        [PreserveSig] int GetMeteringChannelCount(out uint pnChannelCount);
        [PreserveSig] int GetChannelsPeakValues(uint u32ChannelCount, [Out, MarshalAs(UnmanagedType.LPArray)] float[] afPeakValues);
        [PreserveSig] int QueryHardwareSupport(out uint pdwHardwareSupportMask);
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
        const int eMultimedia = 1;
        const uint DEVICE_STATE_ACTIVE = 0x00000001;
        const uint CLSCTX_ALL = 0x17;
        const int AUDCLNT_SHAREMODE_SHARED = 0;
        const uint AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000;
        const uint AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM = 0x80000000;
        const uint AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY = 0x08000000;
        const uint AUDCLNT_BUFFERFLAGS_SILENT = 0x00000002;
        const ushort WAVE_FORMAT_PCM = 1;
        const ushort WAVE_FORMAT_IEEE_FLOAT = 3;
        const ushort WAVE_FORMAT_EXTENSIBLE = 0xFFFE;
        const int FFT_SIZE = 2048;
        const int HALF_FFT = FFT_SIZE / 2;
        const int STEREO_BINS = 256;

        static Guid IID_IAudioClient = new Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2");
        static Guid IID_IAudioCaptureClient = new Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317");
        static Guid IID_IAudioMeterInformation = new Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064");
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

        static Stream stderrStream = null;

        static void EmitStatus(string line)
        {
            try
            {
                if (stderrStream == null) stderrStream = Console.OpenStandardError();
                byte[] bytes = Encoding.UTF8.GetBytes(line + "\n");
                stderrStream.Write(bytes, 0, bytes.Length);
                stderrStream.Flush();
            }
            catch { }
        }

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
                    return string.IsNullOrEmpty(name) ? "Audio Output" : name;
                }
                Marshal.ReleaseComObject(store);
            }
            catch { }
            return "Audio Output";
        }

        static float GetEndpointPeak(IMMDevice device)
        {
            object meterObj = null;
            try
            {
                Guid iid = IID_IAudioMeterInformation;
                int hr = device.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out meterObj);
                if (hr == 0 && meterObj != null)
                {
                    var meter = (IAudioMeterInformation)meterObj;
                    float peak;
                    if (meter.GetPeakValue(out peak) == 0 && !float.IsNaN(peak) && !float.IsInfinity(peak))
                    {
                        return Math.Max(0f, peak);
                    }
                }
            }
            catch { }
            finally
            {
                if (meterObj != null)
                {
                    try { Marshal.ReleaseComObject(meterObj); } catch { }
                }
            }
            return 0f;
        }

        static string GetDefaultDeviceId(IMMDeviceEnumerator enumerator, int role)
        {
            IMMDevice dev = null;
            try
            {
                if (enumerator.GetDefaultAudioEndpoint(eRender, role, out dev) == 0 && dev != null)
                {
                    string id;
                    if (dev.GetId(out id) == 0) return id ?? "";
                }
            }
            catch { }
            finally
            {
                if (dev != null)
                {
                    try { Marshal.ReleaseComObject(dev); } catch { }
                }
            }
            return "";
        }

        static float GetDevicePeakById(IMMDeviceEnumerator enumerator, string deviceId)
        {
            if (string.IsNullOrEmpty(deviceId)) return 0f;
            IMMDevice dev = null;
            try
            {
                if (enumerator.GetDevice(deviceId, out dev) == 0 && dev != null)
                {
                    return GetEndpointPeak(dev);
                }
            }
            catch { }
            finally
            {
                if (dev != null)
                {
                    try { Marshal.ReleaseComObject(dev); } catch { }
                }
            }
            return 0f;
        }

        static void FindLoudestActiveDevice(
            IMMDeviceEnumerator enumerator,
            out string bestId,
            out string bestName,
            out float bestPeak
        )
        {
            bestId = "";
            bestName = "";
            bestPeak = 0f;

            IMMDeviceCollection col = null;
            try
            {
                if (enumerator.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, out col) != 0 || col == null)
                {
                    return;
                }
                uint count;
                col.GetCount(out count);
                for (uint i = 0; i < count; i++)
                {
                    IMMDevice dev = null;
                    try
                    {
                        if (col.Item(i, out dev) != 0 || dev == null) continue;
                        float peak = GetEndpointPeak(dev);
                        if (peak > bestPeak)
                        {
                            string id;
                            dev.GetId(out id);
                            bestPeak = peak;
                            bestId = id ?? "";
                            bestName = GetDeviceName(dev);
                        }
                    }
                    catch { }
                    finally
                    {
                        if (dev != null)
                        {
                            try { Marshal.ReleaseComObject(dev); } catch { }
                        }
                    }
                }
            }
            catch { }
            finally
            {
                if (col != null)
                {
                    try { Marshal.ReleaseComObject(col); } catch { }
                }
            }
        }

        static List<string> GetCandidateDeviceIds(
            IMMDeviceEnumerator enumerator,
            string requestedDeviceId,
            string preferredActiveId
        )
        {
            var result = new List<string>();
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

            Action<string> add = (id) =>
            {
                if (!string.IsNullOrEmpty(id) && seen.Add(id))
                {
                    result.Add(id);
                }
            };

            bool isAuto = string.IsNullOrEmpty(requestedDeviceId) || requestedDeviceId == "default";
            if (!isAuto)
            {
                add(requestedDeviceId);
            }
            else
            {
                add(preferredActiveId);

                // If another active output already has live sound (e.g. Bluetooth headphones, HDMI, Volume Mixer routing), try it first
                string loudestId, loudestName;
                float loudestPeak;
                FindLoudestActiveDevice(enumerator, out loudestId, out loudestName, out loudestPeak);
                if (loudestPeak > 0.0008f)
                {
                    add(loudestId);
                }
            }

            // Prefer eMultimedia (music apps like Spotify) before eConsole
            add(GetDefaultDeviceId(enumerator, eMultimedia));
            add(GetDefaultDeviceId(enumerator, eConsole));

            // Add all remaining active render devices as fallback (e.g. if default is in exclusive mode)
            IMMDeviceCollection col = null;
            try
            {
                if (enumerator.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, out col) == 0 && col != null)
                {
                    uint count;
                    col.GetCount(out count);
                    for (uint i = 0; i < count; i++)
                    {
                        IMMDevice dev = null;
                        try
                        {
                            if (col.Item(i, out dev) != 0 || dev == null) continue;
                            string id;
                            if (dev.GetId(out id) == 0) add(id);
                        }
                        catch { }
                        finally
                        {
                            if (dev != null)
                            {
                                try { Marshal.ReleaseComObject(dev); } catch { }
                            }
                        }
                    }
                }
            }
            catch { }
            finally
            {
                if (col != null)
                {
                    try { Marshal.ReleaseComObject(col); } catch { }
                }
            }

            return result;
        }

        static bool ParseWaveFormat(IntPtr formatPtr, out WaveFormatEx fmt, out bool isFloat, out bool isPcm)
        {
            fmt = (WaveFormatEx)Marshal.PtrToStructure(formatPtr, typeof(WaveFormatEx));
            isFloat = fmt.wFormatTag == WAVE_FORMAT_IEEE_FLOAT;
            isPcm = fmt.wFormatTag == WAVE_FORMAT_PCM;

            if (fmt.wFormatTag == WAVE_FORMAT_EXTENSIBLE && fmt.cbSize >= 22)
            {
                var subFmtBytes = new byte[16];
                Marshal.Copy(IntPtr.Add(formatPtr, 24), subFmtBytes, 0, 16);
                var subFmt = new Guid(subFmtBytes);
                isFloat = subFmt == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT;
                isPcm = subFmt == KSDATAFORMAT_SUBTYPE_PCM;
            }

            if (isFloat)
            {
                return fmt.wBitsPerSample == 32 || fmt.wBitsPerSample == 64;
            }
            if (isPcm)
            {
                return fmt.wBitsPerSample == 8 || fmt.wBitsPerSample == 16 || fmt.wBitsPerSample == 24 || fmt.wBitsPerSample == 32;
            }
            return false;
        }

        static IntPtr AllocStereoFloatFormat(uint sampleRate)
        {
            var wfx = new WaveFormatEx
            {
                wFormatTag = WAVE_FORMAT_IEEE_FLOAT,
                nChannels = 2,
                nSamplesPerSec = sampleRate > 0 ? sampleRate : 48000u,
                wBitsPerSample = 32,
                nBlockAlign = 8,
                nAvgBytesPerSec = (sampleRate > 0 ? sampleRate : 48000u) * 8u,
                cbSize = 0
            };
            IntPtr ptr = Marshal.AllocCoTaskMem(Marshal.SizeOf(typeof(WaveFormatEx)));
            Marshal.StructureToPtr(wfx, ptr, false);
            return ptr;
        }

        static bool TrySingleInit(
            IMMDevice device,
            uint streamFlags,
            long bufferDuration,
            IntPtr formatPtr,
            out IAudioClient audioClient,
            out int hrOut
        )
        {
            audioClient = null;
            object clientObj = null;
            Guid iid = IID_IAudioClient;
            hrOut = device.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out clientObj);
            if (hrOut != 0 || clientObj == null)
            {
                return false;
            }

            var client = (IAudioClient)clientObj;
            hrOut = client.Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                streamFlags,
                bufferDuration,
                0,
                formatPtr,
                IntPtr.Zero
            );

            if (hrOut == 0)
            {
                audioClient = client;
                return true;
            }

            try { Marshal.ReleaseComObject(client); } catch { }
            return false;
        }

        static bool TryInitializeLoopback(
            IMMDevice device,
            bool forceAutoconvert,
            out IAudioClient audioClient,
            out WaveFormatEx activeFmt,
            out bool isFloat,
            out bool isPcm,
            out string initMode,
            out string lastError
        )
        {
            audioClient = null;
            activeFmt = new WaveFormatEx();
            isFloat = false;
            isPcm = false;
            initMode = "";
            lastError = "";

            IntPtr mixFormatPtr = IntPtr.Zero;
            IntPtr stereoDesiredPtr = IntPtr.Zero;
            IntPtr closestMatchPtr = IntPtr.Zero;
            IntPtr stereo48kPtr = IntPtr.Zero;
            IAudioClient probeClient = null;

            try
            {
                object probeObj;
                Guid iid = IID_IAudioClient;
                int hr = device.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out probeObj);
                if (hr != 0 || probeObj == null)
                {
                    lastError = "Activate IAudioClient failed (0x" + hr.ToString("X8") + ")";
                    return false;
                }
                probeClient = (IAudioClient)probeObj;

                uint preferredRate = 48000;
                bool mixSupported = false;
                WaveFormatEx mixFmt = new WaveFormatEx();
                bool mixIsFloat = false;
                bool mixIsPcm = false;

                hr = probeClient.GetMixFormat(out mixFormatPtr);
                if (hr == 0 && mixFormatPtr != IntPtr.Zero)
                {
                    mixSupported = ParseWaveFormat(mixFormatPtr, out mixFmt, out mixIsFloat, out mixIsPcm);
                    if (mixFmt.nSamplesPerSec >= 8000 && mixFmt.nSamplesPerSec <= 384000)
                    {
                        preferredRate = mixFmt.nSamplesPerSec;
                    }
                }

                if (!forceAutoconvert)
                {
                    // Stage 1: Mix format with auto-aligned default buffer (0) — fixes Intel SST & Realtek alignment errors
                    if (mixSupported && mixFormatPtr != IntPtr.Zero)
                    {
                        int hr1;
                        if (TrySingleInit(device, AUDCLNT_STREAMFLAGS_LOOPBACK, 0, mixFormatPtr, out audioClient, out hr1))
                        {
                            activeFmt = mixFmt;
                            isFloat = mixIsFloat;
                            isPcm = mixIsPcm;
                            initMode = "mix-auto";
                            return true;
                        }
                        lastError = "Initialize(mix-auto) 0x" + hr1.ToString("X8");

                        // Stage 2: Mix format with explicit 100ms buffer
                        int hr2;
                        if (TrySingleInit(device, AUDCLNT_STREAMFLAGS_LOOPBACK, 1000000, mixFormatPtr, out audioClient, out hr2))
                        {
                            activeFmt = mixFmt;
                            isFloat = mixIsFloat;
                            isPcm = mixIsPcm;
                            initMode = "mix-100ms";
                            return true;
                        }
                        lastError = "Initialize(mix-100ms) 0x" + hr2.ToString("X8");
                    }

                    // Stage 3: Query driver's closest supported stereo float format
                    stereoDesiredPtr = AllocStereoFloatFormat(preferredRate);
                    int hrSup = probeClient.IsFormatSupported(AUDCLNT_SHAREMODE_SHARED, stereoDesiredPtr, out closestMatchPtr);
                    IntPtr stage3Ptr = IntPtr.Zero;
                    if (hrSup == 0)
                    {
                        stage3Ptr = stereoDesiredPtr;
                    }
                    else if (hrSup == 1 && closestMatchPtr != IntPtr.Zero)
                    {
                        stage3Ptr = closestMatchPtr;
                    }

                    if (stage3Ptr != IntPtr.Zero)
                    {
                        WaveFormatEx s3Fmt;
                        bool s3Float, s3Pcm;
                        if (ParseWaveFormat(stage3Ptr, out s3Fmt, out s3Float, out s3Pcm))
                        {
                            int hr3;
                            if (TrySingleInit(device, AUDCLNT_STREAMFLAGS_LOOPBACK, 0, stage3Ptr, out audioClient, out hr3))
                            {
                                activeFmt = s3Fmt;
                                isFloat = s3Float;
                                isPcm = s3Pcm;
                                initMode = "closest-match";
                                return true;
                            }
                            lastError = "Initialize(closest-match) 0x" + hr3.ToString("X8");
                        }
                    }
                }

                // Stage 4: Force WASAPI built-in resampler/converter to clean 48kHz stereo 32-bit float (bypasses exotic/spatial formats)
                stereo48kPtr = AllocStereoFloatFormat(48000);
                uint autoConvFlags = AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;
                int hr4;
                if (TrySingleInit(device, autoConvFlags, 0, stereo48kPtr, out audioClient, out hr4))
                {
                    ParseWaveFormat(stereo48kPtr, out activeFmt, out isFloat, out isPcm);
                    initMode = "autoconvert-48k";
                    return true;
                }
                lastError = "Initialize(autoconvert) 0x" + hr4.ToString("X8");

                return false;
            }
            finally
            {
                if (probeClient != null)
                {
                    try { Marshal.ReleaseComObject(probeClient); } catch { }
                }
                if (mixFormatPtr != IntPtr.Zero) Marshal.FreeCoTaskMem(mixFormatPtr);
                if (closestMatchPtr != IntPtr.Zero) Marshal.FreeCoTaskMem(closestMatchPtr);
                if (stereoDesiredPtr != IntPtr.Zero) Marshal.FreeCoTaskMem(stereoDesiredPtr);
                if (stereo48kPtr != IntPtr.Zero) Marshal.FreeCoTaskMem(stereo48kPtr);
            }
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
            string defaultId = GetDefaultDeviceId(enumerator, eMultimedia);
            if (string.IsNullOrEmpty(defaultId))
            {
                defaultId = GetDefaultDeviceId(enumerator, eConsole);
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
            bool first = true;
            for (uint i = 0; i < count; i++)
            {
                IMMDevice dev;
                if (col.Item(i, out dev) != 0 || dev == null) continue;
                string id;
                dev.GetId(out id);
                string name = GetDeviceName(dev);
                bool isDefault = string.Equals(id, defaultId, StringComparison.OrdinalIgnoreCase);
                if (!first) sb.Append(',');
                first = false;
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

        static void PrintDiagEndpoints(IMMDeviceEnumerator enumerator)
        {
            string mmId = GetDefaultDeviceId(enumerator, eMultimedia);
            string conId = GetDefaultDeviceId(enumerator, eConsole);
            IMMDeviceCollection col = null;
            try
            {
                if (enumerator.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, out col) != 0 || col == null)
                {
                    Console.WriteLine("DIAG_ENDPOINTS count=0");
                    return;
                }
                uint count;
                col.GetCount(out count);
                Console.WriteLine("DIAG_ENDPOINTS count=" + count);
                for (uint i = 0; i < count; i++)
                {
                    IMMDevice dev = null;
                    try
                    {
                        if (col.Item(i, out dev) != 0 || dev == null) continue;
                        string id;
                        dev.GetId(out id);
                        string name = GetDeviceName(dev);
                        float peak = GetEndpointPeak(dev);
                        bool isMm = string.Equals(id, mmId, StringComparison.OrdinalIgnoreCase);
                        bool isCon = string.Equals(id, conId, StringComparison.OrdinalIgnoreCase);
                        Console.WriteLine(
                            "  [" + i + "] \"" + name + "\" mm=" + isMm +
                            " console=" + isCon +
                            " meterPeak=" + peak.ToString("F4")
                        );
                    }
                    finally
                    {
                        if (dev != null) Marshal.ReleaseComObject(dev);
                    }
                }
            }
            finally
            {
                if (col != null) Marshal.ReleaseComObject(col);
            }
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

        [MTAThread]
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

            try
            {
                Console.Error.Write("");
            }
            catch { }

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
            var ringL = new float[FFT_SIZE];
            var ringR = new float[FFT_SIZE];
            int ringPos = 0;

            var reL = new double[FFT_SIZE];
            var imL = new double[FFT_SIZE];
            var reR = new double[FFT_SIZE];
            var imR = new double[FFT_SIZE];
            var smoothMag = new double[HALF_FFT];
            var smoothMagL = new double[HALF_FFT];
            var smoothMagR = new double[HALF_FFT];
            double smoothStereoWidth = 0.0;
            double smoothStereoBalance = 0.0;

            // SVA2 packet layout (4112 bytes):
            // [0..3]     "SVA2"
            // [4..7]     uint32 sampleRate
            // [8..11]    float32 stereoWidth (0..1)
            // [12..15]   float32 stereoBalance (-1..+1)
            // [16..1039] combined FFT (1024 bytes)
            // [1040..3087] combined PCM waveform (2048 bytes)
            // [3088..3343] log-mapped Left FFT (256 bytes)
            // [3344..3599] log-mapped Right FFT (256 bytes)
            // [3600..3855] Left waveform (256 bytes)
            // [3856..4111] Right waveform (256 bytes)
            const int HEADER_SIZE = 16;
            const int OFF_FREQ = HEADER_SIZE;
            const int OFF_TIME = OFF_FREQ + HALF_FFT;
            const int OFF_L_FREQ = OFF_TIME + FFT_SIZE;
            const int OFF_R_FREQ = OFF_L_FREQ + STEREO_BINS;
            const int OFF_L_TIME = OFF_R_FREQ + STEREO_BINS;
            const int OFF_R_TIME = OFF_L_TIME + STEREO_BINS;
            var packet = new byte[OFF_R_TIME + STEREO_BINS];
            packet[0] = (byte)'S';
            packet[1] = (byte)'V';
            packet[2] = (byte)'A';
            packet[3] = (byte)'2';

            bool isAutoMode = string.IsNullOrEmpty(requestedDeviceId) || requestedDeviceId == "default";
            string pinnedActiveId = "";
            string forceAutoconvertDeviceId = "";
            string lastReportedError = "";

            if (diagMode)
            {
                Console.OutputEncoding = Encoding.UTF8;
                PrintDiagEndpoints(enumerator);
            }

            while (true)
            {
                IMMDevice device = null;
                IAudioClient audioClient = null;
                IAudioCaptureClient captureClient = null;

                try
                {
                    var candidates = GetCandidateDeviceIds(enumerator, requestedDeviceId, pinnedActiveId);
                    if (candidates.Count == 0)
                    {
                        string msg = "No active Windows audio playback devices found";
                        if (msg != lastReportedError)
                        {
                            EmitStatus("WASAPI_ERR:" + msg);
                            lastReportedError = msg;
                        }
                        if (diagMode)
                        {
                            Console.Error.WriteLine("DIAG_ERROR: " + msg);
                            return 1;
                        }
                        Thread.Sleep(600);
                        continue;
                    }

                    WaveFormatEx fmt = new WaveFormatEx();
                    bool isFloat = false;
                    bool isPcm = false;
                    string initMode = "";
                    string activeDeviceId = "";
                    string activeDeviceName = "Audio Output";
                    string lastAttemptErr = "";

                    foreach (string candId in candidates)
                    {
                        IMMDevice candDev = null;
                        try
                        {
                            if (enumerator.GetDevice(candId, out candDev) != 0 || candDev == null)
                            {
                                continue;
                            }

                            IAudioClient trialClient;
                            WaveFormatEx trialFmt;
                            bool trialFloat, trialPcm;
                            string trialMode, trialErr;

                            bool useForceAuto = string.Equals(candId, forceAutoconvertDeviceId, StringComparison.OrdinalIgnoreCase);
                            if (TryInitializeLoopback(candDev, useForceAuto, out trialClient, out trialFmt, out trialFloat, out trialPcm, out trialMode, out trialErr))
                            {
                                device = candDev;
                                candDev = null; // Ownership transferred
                                audioClient = trialClient;
                                fmt = trialFmt;
                                isFloat = trialFloat;
                                isPcm = trialPcm;
                                initMode = trialMode;
                                activeDeviceId = candId;
                                activeDeviceName = GetDeviceName(device);
                                break;
                            }
                            else
                            {
                                lastAttemptErr = GetDeviceName(candDev) + ": " + trialErr;
                            }
                        }
                        finally
                        {
                            if (candDev != null)
                            {
                                try { Marshal.ReleaseComObject(candDev); } catch { }
                            }
                        }
                    }

                    if (device == null || audioClient == null)
                    {
                        string msg = string.IsNullOrEmpty(lastAttemptErr)
                            ? "Could not open any Windows audio playback device"
                            : lastAttemptErr;
                        if (msg != lastReportedError)
                        {
                            EmitStatus("WASAPI_ERR:" + msg);
                            lastReportedError = msg;
                        }
                        if (diagMode)
                        {
                            Console.Error.WriteLine("DIAG_ERROR: " + msg);
                            return 1;
                        }
                        pinnedActiveId = "";
                        Thread.Sleep(600);
                        continue;
                    }

                    object capObj;
                    Guid capIid = IID_IAudioCaptureClient;
                    int hr = audioClient.GetService(ref capIid, out capObj);
                    if (hr != 0 || capObj == null) throw new COMException("GetService IAudioCaptureClient failed", hr);
                    captureClient = (IAudioCaptureClient)capObj;

                    hr = audioClient.Start();
                    if (hr != 0) throw new COMException("IAudioClient.Start failed", hr);

                    uint sampleRate = fmt.nSamplesPerSec;
                    int channels = Math.Max(1, (int)fmt.nChannels);
                    int bytesPerSample = Math.Max(1, fmt.wBitsPerSample / 8);
                    int blockAlign = Math.Max(channels * bytesPerSample, (int)fmt.nBlockAlign);
                    lastReportedError = "";

                    if (diagMode)
                    {
                        Console.WriteLine(
                            "OPEN_OK device=\"" + activeDeviceName +
                            "\" mode=" + initMode +
                            " sampleRate=" + sampleRate +
                            " channels=" + channels +
                            " bits=" + fmt.wBitsPerSample +
                            " float=" + isFloat +
                            " pcm=" + isPcm
                        );
                    }
                    else
                    {
                        EmitStatus(
                            "WASAPI_OPEN:" + activeDeviceName + "|" +
                            initMode + " · " + sampleRate + "Hz · " + channels + "ch"
                        );
                    }

                    // Write sampleRate into packet header (little-endian uint32)
                    packet[4] = (byte)(sampleRate & 0xFF);
                    packet[5] = (byte)((sampleRate >> 8) & 0xFF);
                    packet[6] = (byte)((sampleRate >> 16) & 0xFF);
                    packet[7] = (byte)((sampleRate >> 24) & 0xFF);

                    byte[] rawBuf = new byte[65536];
                    int ticksSinceAudio = 0;
                    int ticksSinceEndpointCheck = 0;
                    int meterMismatchWindows = 0;
                    bool reportedSilentApo = false;
                    double windowPeak = 0.0;
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
                                    ringL[ringPos] = 0f;
                                    ringR[ringPos] = 0f;
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
                                    double chL = 0.0;
                                    double chR = 0.0;
                                    double frontEnergy = 0.0;
                                    double surroundL = 0.0;
                                    double surroundR = 0.0;
                                    double centerLfe = 0.0;

                                    for (int ch = 0; ch < channels; ch++)
                                    {
                                        int sampleOffset = frameOffset + ch * bytesPerSample;
                                        double sample = 0.0;
                                        if (isFloat && bytesPerSample == 4)
                                        {
                                            sample = BitConverter.ToSingle(rawBuf, sampleOffset);
                                        }
                                        else if (isFloat && bytesPerSample == 8)
                                        {
                                            sample = BitConverter.ToDouble(rawBuf, sampleOffset);
                                        }
                                        else if (isPcm && bytesPerSample == 1)
                                        {
                                            sample = (rawBuf[sampleOffset] - 128) / 128.0;
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

                                        if (channels == 1)
                                        {
                                            chL = sample;
                                            chR = sample;
                                            frontEnergy += Math.Abs(sample);
                                        }
                                        else if (ch == 0)
                                        {
                                            chL = sample;
                                            frontEnergy += Math.Abs(sample);
                                        }
                                        else if (ch == 1)
                                        {
                                            chR = sample;
                                            frontEnergy += Math.Abs(sample);
                                        }
                                        else if (channels >= 6 && (ch == 2 || ch == 3))
                                        {
                                            // Standard 5.1 / 7.1 Center (ch 2) and LFE (ch 3) split evenly to L & R
                                            centerLfe += sample * (ch == 2 ? 0.5 : 0.3);
                                        }
                                        else if ((ch & 1) == 0)
                                        {
                                            surroundL += sample;
                                        }
                                        else
                                        {
                                            surroundR += sample;
                                        }
                                    }

                                    double leftSample, rightSample;
                                    if (channels > 2 && frontEnergy < 1e-6 && (Math.Abs(surroundL) + Math.Abs(surroundR) + Math.Abs(centerLfe)) > 1e-6)
                                    {
                                        leftSample = surroundL * 0.5 + centerLfe;
                                        rightSample = surroundR * 0.5 + centerLfe;
                                    }
                                    else
                                    {
                                        leftSample = chL + centerLfe + surroundL * 0.25;
                                        rightSample = chR + centerLfe + surroundR * 0.25;
                                    }

                                    if (leftSample > 1.0) leftSample = 1.0;
                                    else if (leftSample < -1.0) leftSample = -1.0;
                                    if (rightSample > 1.0) rightSample = 1.0;
                                    else if (rightSample < -1.0) rightSample = -1.0;

                                    double absPeak = Math.Max(Math.Abs(leftSample), Math.Abs(rightSample));
                                    if (absPeak > diagPeak) diagPeak = absPeak;
                                    if (absPeak > windowPeak) windowPeak = absPeak;

                                    ringL[ringPos] = (float)leftSample;
                                    ringR[ringPos] = (float)rightSample;
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
                                    ringL[ringPos] = 0f;
                                    ringR[ringPos] = 0f;
                                    ringPos = (ringPos + 1) & (FFT_SIZE - 1);
                                }
                            }
                        }

                        // Compute stereo metrics + 2048-pt Hann-windowed L & R FFTs (combined mid FFT = 0.5*(L+R) by linearity!)
                        double sumL2 = 0.0;
                        double sumR2 = 0.0;
                        double sumMid2 = 0.0;
                        double sumSide2 = 0.0;

                        for (int i = 0; i < FFT_SIZE; i++)
                        {
                            int idx = (ringPos + i) & (FFT_SIZE - 1);
                            float sL = ringL[idx];
                            float sR = ringR[idx];
                            float mid = 0.5f * (sL + sR);
                            float side = 0.5f * (sL - sR);

                            sumL2 += sL * sL;
                            sumR2 += sR * sR;
                            sumMid2 += mid * mid;
                            sumSide2 += side * side;

                            double w = hann[i];
                            reL[i] = sL * w;
                            imL[i] = 0.0;
                            reR[i] = sR * w;
                            imR[i] = 0.0;

                            int waveByte = (int)Math.Round(128.0 + mid * 127.0);
                            if (waveByte < 0) waveByte = 0;
                            else if (waveByte > 255) waveByte = 255;
                            packet[OFF_TIME + i] = (byte)waveByte;
                        }

                        // Pack 256-sample stereo L/R waveforms from the latest 1024 samples (~21ms window)
                        int recentStart = (ringPos + (FFT_SIZE - 1024)) & (FFT_SIZE - 1);
                        for (int i = 0; i < STEREO_BINS; i++)
                        {
                            int idx = (recentStart + i * 4) & (FFT_SIZE - 1);
                            int bL = (int)Math.Round(128.0 + ringL[idx] * 127.0);
                            int bR = (int)Math.Round(128.0 + ringR[idx] * 127.0);
                            packet[OFF_L_TIME + i] = (byte)(bL < 0 ? 0 : (bL > 255 ? 255 : bL));
                            packet[OFF_R_TIME + i] = (byte)(bR < 0 ? 0 : (bR > 255 ? 255 : bR));
                        }

                        double rmsL = Math.Sqrt(sumL2 / FFT_SIZE);
                        double rmsR = Math.Sqrt(sumR2 / FFT_SIZE);
                        double rmsMid = Math.Sqrt(sumMid2 / FFT_SIZE);
                        double rmsSide = Math.Sqrt(sumSide2 / FFT_SIZE);
                        double targetWidth = (rmsMid + rmsSide > 0.0004)
                            ? Math.Min(1.0, (rmsSide / (rmsMid + rmsSide * 0.45 + 1e-6)) * 1.45)
                            : 0.0;
                        double targetBalance = (rmsL + rmsR > 0.0004)
                            ? Math.Max(-1.0, Math.Min(1.0, (rmsR - rmsL) / (rmsL + rmsR + 1e-6)))
                            : 0.0;
                        smoothStereoWidth = smoothStereoWidth * 0.72 + targetWidth * 0.28;
                        smoothStereoBalance = smoothStereoBalance * 0.72 + targetBalance * 0.28;

                        byte[] widthBytes = BitConverter.GetBytes((float)smoothStereoWidth);
                        byte[] balBytes = BitConverter.GetBytes((float)smoothStereoBalance);
                        Buffer.BlockCopy(widthBytes, 0, packet, 8, 4);
                        Buffer.BlockCopy(balBytes, 0, packet, 12, 4);

                        FftInPlace(reL, imL);
                        FftInPlace(reR, imR);

                        // Scale to match AnalyserNode dB mapping (-92 dB .. -12 dB, smoothing = 0.48)
                        const double minDb = -92.0;
                        const double maxDb = -12.0;
                        const double invRange = 255.0 / (maxDb - minDb);
                        const double norm = 2.0 / FFT_SIZE;

                        for (int i = 0; i < HALF_FFT; i++)
                        {
                            double mRe = 0.5 * (reL[i] + reR[i]);
                            double mIm = 0.5 * (imL[i] + imR[i]);
                            double magMid = Math.Sqrt(mRe * mRe + mIm * mIm) * norm;
                            double magL = Math.Sqrt(reL[i] * reL[i] + imL[i] * imL[i]) * norm;
                            double magR = Math.Sqrt(reR[i] * reR[i] + imR[i] * imR[i]) * norm;

                            smoothMag[i] = smoothMag[i] * 0.48 + magMid * 0.52;
                            smoothMagL[i] = smoothMagL[i] * 0.48 + magL * 0.52;
                            smoothMagR[i] = smoothMagR[i] * 0.48 + magR * 0.52;

                            double db = smoothMag[i] > 1e-10 ? 20.0 * Math.Log10(smoothMag[i]) : minDb;
                            int b = (int)Math.Round((db - minDb) * invRange);
                            packet[OFF_FREQ + i] = (byte)(b < 0 ? 0 : (b > 255 ? 255 : b));
                        }

                        // Pack 256 log-mapped stereo L & R frequency bins aligned with DSP (up to 16 kHz)
                        double binHz = (double)sampleRate / FFT_SIZE;
                        int maxStereoBin = Math.Min(HALF_FFT - 1, Math.Max(8, (int)Math.Floor(16000.0 / Math.Max(1.0, binHz))));
                        for (int x = 0; x < STEREO_BINS; x++)
                        {
                            double u = (double)x / (STEREO_BINS - 1);
                            int logIdx = (int)Math.Floor(Math.Pow(Math.Max(2, maxStereoBin), u));
                            if (logIdx < 1) logIdx = 1;
                            else if (logIdx > maxStereoBin) logIdx = maxStereoBin;

                            double dbL = smoothMagL[logIdx] > 1e-10 ? 20.0 * Math.Log10(smoothMagL[logIdx]) : minDb;
                            int bL = (int)Math.Round((dbL - minDb) * invRange);
                            packet[OFF_L_FREQ + x] = (byte)(bL < 0 ? 0 : (bL > 255 ? 255 : bL));

                            double dbR = smoothMagR[logIdx] > 1e-10 ? 20.0 * Math.Log10(smoothMagR[logIdx]) : minDb;
                            int bR = (int)Math.Round((dbR - minDb) * invRange);
                            packet[OFF_R_FREQ + x] = (byte)(bR < 0 ? 0 : (bR > 255 ? 255 : bR));
                        }

                        if (diagMode)
                        {
                            diagTicks++;
                            if (diagTicks >= 40)
                            {
                                int maxFft = 0;
                                for (int i = 1; i < HALF_FFT; i++) if (packet[OFF_FREQ + i] > maxFft) maxFft = packet[OFF_FREQ + i];
                                Console.WriteLine(
                                    "DIAG_RESULT packets=" + diagPackets +
                                    " peakSample=" + diagPeak.ToString("F4") +
                                    " maxFftByte=" + maxFft +
                                    " stereoWidth=" + smoothStereoWidth.ToString("F3") +
                                    " balance=" + smoothStereoBalance.ToString("F3")
                                );
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

                        // Periodically follow default playback device switches AND auto-hunt any active audio output on laptops
                        if (isAutoMode)
                        {
                            ticksSinceEndpointCheck++;
                            if (ticksSinceEndpointCheck >= 75)
                            {
                                ticksSinceEndpointCheck = 0;
                                bool currentlySilent = windowPeak < 0.0004;
                                windowPeak = 0.0;

                                string defaultMmId = GetDefaultDeviceId(enumerator, eMultimedia);
                                if (string.IsNullOrEmpty(defaultMmId))
                                {
                                    defaultMmId = GetDefaultDeviceId(enumerator, eConsole);
                                }

                                if (currentlySilent)
                                {
                                    // Scan all active render endpoints — if music is playing on Bluetooth headphones, speakers, HDMI, or Volume Mixer output, switch automatically!
                                    string loudestId, loudestName;
                                    float loudestPeak;
                                    FindLoudestActiveDevice(enumerator, out loudestId, out loudestName, out loudestPeak);

                                    if (loudestPeak > 0.0008f && !string.Equals(loudestId, activeDeviceId, StringComparison.OrdinalIgnoreCase))
                                    {
                                        pinnedActiveId = loudestId;
                                        forceAutoconvertDeviceId = "";
                                        if (!diagMode) EmitStatus("WASAPI_SWITCH:" + loudestName);
                                        break;
                                    }

                                    // Detect Intel SST / Realtek APO silent loopback: endpoint meter shows live audio, yet our loopback buffer got pure zeros!
                                    float selfPeak = GetEndpointPeak(device);
                                    if (selfPeak > 0.002f)
                                    {
                                        meterMismatchWindows++;
                                        if (meterMismatchWindows >= 2)
                                        {
                                            if (initMode != "autoconvert-48k" && !string.Equals(forceAutoconvertDeviceId, activeDeviceId, StringComparison.OrdinalIgnoreCase))
                                            {
                                                forceAutoconvertDeviceId = activeDeviceId;
                                                pinnedActiveId = activeDeviceId;
                                                if (!diagMode) EmitStatus("WASAPI_SWITCH:" + activeDeviceName + " (retrying format)");
                                                break;
                                            }
                                            else if (!reportedSilentApo && !diagMode)
                                            {
                                                reportedSilentApo = true;
                                                EmitStatus("WASAPI_SILENT_APO:" + activeDeviceName);
                                            }
                                        }
                                    }
                                    else
                                    {
                                        meterMismatchWindows = 0;
                                    }

                                    // Otherwise follow Windows default playback device changes
                                    if (!string.IsNullOrEmpty(defaultMmId) && !string.Equals(defaultMmId, activeDeviceId, StringComparison.OrdinalIgnoreCase))
                                    {
                                        pinnedActiveId = "";
                                        forceAutoconvertDeviceId = "";
                                        break;
                                    }
                                }
                                else
                                {
                                    meterMismatchWindows = 0;
                                    reportedSilentApo = false;
                                    if (!string.IsNullOrEmpty(defaultMmId) && !string.Equals(defaultMmId, activeDeviceId, StringComparison.OrdinalIgnoreCase))
                                    {
                                        // We're currently getting audio on a non-default device (e.g. Volume Mixer routing);
                                        // only switch to the new default if the new default is also actively playing
                                        if (GetDevicePeakById(enumerator, defaultMmId) > 0.0008f)
                                        {
                                            pinnedActiveId = "";
                                            forceAutoconvertDeviceId = "";
                                            break;
                                        }
                                    }
                                }
                            }
                        }

                        Thread.Sleep(16);
                    }
                }
                catch (Exception ex)
                {
                    string msg = ex.Message;
                    if (msg != lastReportedError)
                    {
                        EmitStatus("WASAPI_ERR:" + msg);
                        lastReportedError = msg;
                    }
                    if (diagMode)
                    {
                        Console.Error.WriteLine("DIAG_ERROR: " + msg);
                        return 1;
                    }
                    pinnedActiveId = "";
                    Thread.Sleep(500);
                }
                finally
                {
                    if (audioClient != null)
                    {
                        try { audioClient.Stop(); } catch { }
                    }
                    if (captureClient != null)
                    {
                        try { Marshal.ReleaseComObject(captureClient); } catch { }
                    }
                    if (audioClient != null)
                    {
                        try { Marshal.ReleaseComObject(audioClient); } catch { }
                    }
                    if (device != null)
                    {
                        try { Marshal.ReleaseComObject(device); } catch { }
                    }
                }
            }
        }
    }
}

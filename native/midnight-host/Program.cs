// midnight-host: runs one child process inside a Windows Job Object that is
// killed when this host exits for any reason.
//
// Usage: midnight-host.exe <executable> [arguments...]
//
// Ownership chain: the CLI keeps this host's stdin open. When the CLI exits,
// crashes, or closes stdin, the host exits. The host is the only holder of the
// job handle, so closing it triggers JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE and
// terminates the engine and every descendant. A forced kill of the host closes
// the handle the same way.
//
// Built with the .NET Framework 4 compiler included in Windows (C# 5 syntax).
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class MidnightHost
{
	private const int JobObjectExtendedLimitInformation = 9;
	private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
	private const uint JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION = 0x400;

	[StructLayout(LayoutKind.Sequential)]
	private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
	{
		public long PerProcessUserTimeLimit;
		public long PerJobUserTimeLimit;
		public uint LimitFlags;
		public UIntPtr MinimumWorkingSetSize;
		public UIntPtr MaximumWorkingSetSize;
		public uint ActiveProcessLimit;
		public UIntPtr Affinity;
		public uint PriorityClass;
		public uint SchedulingClass;
	}

	[StructLayout(LayoutKind.Sequential)]
	private struct IO_COUNTERS
	{
		public ulong ReadOperationCount;
		public ulong WriteOperationCount;
		public ulong OtherOperationCount;
		public ulong ReadTransferCount;
		public ulong WriteTransferCount;
		public ulong OtherTransferCount;
	}

	[StructLayout(LayoutKind.Sequential)]
	private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
	{
		public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
		public IO_COUNTERS IoInfo;
		public UIntPtr ProcessMemoryLimit;
		public UIntPtr JobMemoryLimit;
		public UIntPtr PeakProcessMemoryUsed;
		public UIntPtr PeakJobMemoryUsed;
	}

	[DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
	private static extern IntPtr CreateJobObject(IntPtr attributes, string name);

	[DllImport("kernel32.dll", SetLastError = true)]
	private static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, uint length);

	[DllImport("kernel32.dll", SetLastError = true)]
	private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

	[DllImport("kernel32.dll")]
	private static extern IntPtr GetCurrentProcess();

	private static int Main(string[] args)
	{
		if (args.Length < 1 || args[0] == "--help" || args[0] == "-h")
		{
			Console.Error.WriteLine("Usage: midnight-host.exe <executable> [arguments...]");
			return 2;
		}
		if (args[0] == "--version")
		{
			Console.Out.WriteLine("midnight-host 1");
			return 0;
		}

		IntPtr job = CreateJobObject(IntPtr.Zero, null);
		if (job == IntPtr.Zero) return Fail("CreateJobObject");

		JOBOBJECT_EXTENDED_LIMIT_INFORMATION info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
		info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
		uint length = (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
		if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref info, length)) return Fail("SetInformationJobObject");

		// Join the job before starting the child so the child and all of its
		// descendants inherit it with no unowned window. Nested jobs are
		// supported on Windows 8 and later.
		if (!AssignProcessToJobObject(job, GetCurrentProcess())) return Fail("AssignProcessToJobObject");

		ProcessStartInfo start = new ProcessStartInfo();
		start.FileName = args[0];
		start.Arguments = JoinArguments(args, 1);
		start.UseShellExecute = false;
		start.CreateNoWindow = true;
		// stdin stays with the host as the owner-liveness channel.
		start.RedirectStandardInput = true;

		Process child;
		try
		{
			child = Process.Start(start);
		}
		catch (Win32Exception error)
		{
			Console.Error.WriteLine("midnight-host: cannot start " + args[0] + ": " + error.Message);
			return 3;
		}

		Thread watcher = new Thread(delegate ()
		{
			try
			{
				Stream input = Console.OpenStandardInput();
				byte[] buffer = new byte[256];
				while (input.Read(buffer, 0, buffer.Length) > 0) { }
			}
			catch (IOException) { }
			// Owner closed stdin or exited. Exiting closes the job handle.
			Environment.Exit(0);
		});
		watcher.IsBackground = true;
		watcher.Start();

		child.WaitForExit();
		return child.ExitCode;
	}

	private static int Fail(string call)
	{
		Console.Error.WriteLine("midnight-host: " + call + " failed: " + new Win32Exception(Marshal.GetLastWin32Error()).Message);
		return 4;
	}

	// Quote per the MSVCRT/CommandLineToArgvW rules so the child receives the
	// same argv the host received.
	private static string JoinArguments(string[] args, int offset)
	{
		StringBuilder builder = new StringBuilder();
		for (int i = offset; i < args.Length; i++)
		{
			if (builder.Length > 0) builder.Append(' ');
			AppendQuoted(builder, args[i]);
		}
		return builder.ToString();
	}

	private static void AppendQuoted(StringBuilder builder, string arg)
	{
		if (arg.Length > 0 && arg.IndexOfAny(new char[] { ' ', '\t', '\n', '\v', '"' }) < 0)
		{
			builder.Append(arg);
			return;
		}
		builder.Append('"');
		int backslashes = 0;
		foreach (char c in arg)
		{
			if (c == '\\')
			{
				backslashes++;
				continue;
			}
			if (c == '"')
			{
				builder.Append('\\', backslashes * 2 + 1);
			}
			else
			{
				builder.Append('\\', backslashes);
			}
			backslashes = 0;
			builder.Append(c);
		}
		builder.Append('\\', backslashes * 2);
		builder.Append('"');
	}
}

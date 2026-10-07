import { AppError } from '../errors/app-error.ts';

export interface PrivateFileCommand {
	readonly file: string;
	readonly args: readonly string[];
	readonly input: string;
}

export type PrivateFileCommandRunner = (command: PrivateFileCommand) => boolean;

// File.Replace copies the old target's DACL. A same-directory rename keeps the
// new file's protected DACL, including when an existing target has extra ACEs.
const PRIVATE_FILE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
try {
  [Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using Microsoft.Win32.SafeHandles;

public static class PrivatePairingFile {
  [StructLayout(LayoutKind.Sequential)]
  private struct FileIdentity {
    public uint Attributes;
    public System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write;
    public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct Disposition { [MarshalAs(UnmanagedType.Bool)] public bool Delete; }
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileIdentity info);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool MoveFileEx(string source, string target, uint flags);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool SetFileInformationByHandle(SafeFileHandle handle, int kind, ref Disposition info, uint size);

  private static FileIdentity Identity(FileStream file) {
    FileIdentity info;
    if (!GetFileInformationByHandle(file.SafeFileHandle, out info)) throw new IOException("File identity unavailable.");
    return info;
  }
  private static bool Same(FileIdentity a, FileIdentity b) {
    return a.Volume == b.Volume && a.IndexHigh == b.IndexHigh && a.IndexLow == b.IndexLow;
  }
  private static void Verify(FileStream file, SecurityIdentifier sid) {
    var acl = file.GetAccessControl();
    var rules = acl.GetAccessRules(true, true, typeof(SecurityIdentifier));
    if (!acl.AreAccessRulesProtected || !acl.GetOwner(typeof(SecurityIdentifier)).Equals(sid) || rules.Count != 1)
      throw new IOException("Unsafe file permissions.");
    var rule = (FileSystemAccessRule)rules[0];
    if (!rule.IdentityReference.Equals(sid) || rule.IsInherited || rule.AccessControlType != AccessControlType.Allow || rule.FileSystemRights != FileSystemRights.FullControl)
      throw new IOException("Unsafe file permissions.");
  }
  private static void DeleteOwned(string path, FileIdentity identity) {
    try {
      using (var file = new FileStream(path, FileMode.Open, FileSystemRights.FullControl, FileShare.None, 4096, FileOptions.None)) {
        if (!Same(Identity(file), identity)) return;
        var disposition = new Disposition { Delete = true };
        if (!SetFileInformationByHandle(file.SafeFileHandle, 4, ref disposition, (uint)Marshal.SizeOf(disposition)))
          throw new IOException("Private file cleanup failed.");
      }
    } catch (FileNotFoundException) { } catch (DirectoryNotFoundException) { }
  }
  public static void Write(string target, string contents) {
    var sid = WindowsIdentity.GetCurrent().User;
    var security = new FileSecurity();
    security.SetOwner(sid);
    security.SetAccessRuleProtection(true, false);
    security.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl, AccessControlType.Allow));
    var temporary = target + "." + Guid.NewGuid().ToString("N") + ".tmp";
    FileIdentity identity = new FileIdentity();
    bool created = false, published = false;
    try {
      using (var file = new FileStream(temporary, FileMode.CreateNew, FileSystemRights.FullControl, FileShare.None, 4096, FileOptions.WriteThrough, security)) {
        identity = Identity(file);
        created = true;
        Verify(file, sid);
        var bytes = new UTF8Encoding(false).GetBytes(contents);
        file.Write(bytes, 0, bytes.Length);
        file.Flush(true);
      }
      // MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH, without cross-volume copying.
      if (!MoveFileEx(temporary, target, 9)) throw new IOException("Private file publication failed.");
      using (var file = new FileStream(target, FileMode.Open, FileSystemRights.FullControl, FileShare.None, 4096, FileOptions.None)) {
        if (!Same(Identity(file), identity)) throw new IOException("Private file publication raced.");
        Verify(file, sid);
        published = true;
      }
    } finally {
      if (created && !published) {
        try { DeleteOwned(temporary, identity); } finally { DeleteOwned(target, identity); }
      }
    }
  }
}
'@
  [PrivatePairingFile]::Write([string]$request.path, [string]$request.contents)
  [Console]::Out.Write('private-file-written')
} catch {
  [Console]::Error.WriteLine('Could not publish a private pairing file.')
  exit 1
}
`;

export function createWindowsPrivateFileWriter(
	runCommand: PrivateFileCommandRunner,
): (path: string, contents: string) => void {
	return (path, contents) => {
		const ok = runCommand({
			file: 'powershell.exe',
			args: [
				'-NoLogo',
				'-NoProfile',
				'-NonInteractive',
				'-EncodedCommand',
				Buffer.from(PRIVATE_FILE_SCRIPT, 'utf16le').toString('base64'),
			],
			input: JSON.stringify({ path, contents }),
		});
		if (!ok) throw new AppError('E_INTERNAL', 'Could not publish a private pairing file.');
	};
}

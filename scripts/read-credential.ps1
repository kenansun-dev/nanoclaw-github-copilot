# Read a credential from Windows Credential Manager
# Usage: powershell -NoProfile -File read-credential.ps1 <target>
# Output: credential value (UTF-8) or empty string if not found

param([string]$Target)

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public class NanoclawCredReader {
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CredRead(string target, int type, int flags, out IntPtr credential);

    [DllImport("advapi32.dll")]
    static extern void CredFree(IntPtr buffer);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct CREDENTIAL {
        public int Flags;
        public int Type;
        public string TargetName;
        public string Comment;
        public long LastWritten;
        public int CredentialBlobSize;
        public IntPtr CredentialBlob;
        public int Persist;
        public int AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias;
        public string UserName;
    }

    public static string Read(string target) {
        IntPtr ptr;
        if (!CredRead(target, 1, 0, out ptr)) return "";
        var cred = Marshal.PtrToStructure<CREDENTIAL>(ptr);
        byte[] bytes = new byte[cred.CredentialBlobSize];
        Marshal.Copy(cred.CredentialBlob, bytes, 0, cred.CredentialBlobSize);
        CredFree(ptr);
        return Encoding.UTF8.GetString(bytes);
    }
}
"@

$result = [NanoclawCredReader]::Read($Target)
Write-Output $result

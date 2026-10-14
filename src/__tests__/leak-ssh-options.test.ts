import { describe, expect, it } from 'vitest'
import { parseShell } from '../leak-guard/shell-words.js'
import { SSH_PROGRAMS, sshRunsLocalProgram } from '../leak-guard/ssh-options.js'

const runsLocalProgram = (line: string): boolean => {
  const cmd = parseShell(line)[0]
  if (cmd === undefined) throw new Error(`no command in ${line}`)
  return sshRunsLocalProgram(cmd.words[0] ?? '', cmd.marked.slice(1), cmd.splits)
}

describe('ssh options that run a local command (TP-2376)', () => {
  it.each([
    'ssh -oProxyCommand=x h',
    'ssh -o ProxyCommand=x h',
    'ssh h -oProxyCommand=x',
    "ssh -o 'proxycommand x' h",
    `ssh -o '"ProxyCommand"=x' h`,
    "ssh -o '=ProxyCommand x' h",
    'ssh -vo LocalCommand=x h',
    'ssh -o KnownHostsCommand=x h',
    'ssh -o PermitLocalCommand=yes h',
    'ssh -F ./cfg h',
    'ssh -F"$C" h',
    'ssh -o "$O" h',
    'ssh "$H" uptime',
    'ssh -p $P h',
    'ssh -Z h',
    'scp -S ./p a h:b',
    'scp -D ./server a h:b',
    'scp a h:b -oProxyCommand=x',
    'sftp -D /x h',
    'sftp -b batch h',
    'ssh -o',
    'ssh h -o',
    'ssh -F',
    'ssh -vo',
    'scp -S',
    'ssh -I /tmp/lib.so h',
    'ssh -o PKCS11Provider=/tmp/lib.so h',
    'ssh -o smartcarddevice=/tmp/lib.so h',
    'ssh -o SecurityKeyProvider=/tmp/sk.so h',
    'ssh -o XAuthLocation=/tmp/xauth h',
    'scp -o pkcs11provider=/tmp/lib.so a h:b',
  ])('%s runs a local program', line => {
    expect(runsLocalProgram(line)).toBe(true)
  })

  it.each([
    'ssh -J j h',
    'ssh -o StrictHostKeyChecking=no h',
    'ssh -F /dev/null h',
    'ssh -F none h',
    'ssh h sort -o ProxyCommand',
    'ssh -E -oProxyCommand h',
    'ssh -- h -oProxyCommand=x',
    'ssh -p "$P" h uptime',
    'ssh -G -J j h',
    'scp a h:b',
    'scp -P 2222 -i key a h:b',
    'sftp -o BatchMode=yes h',
  ])('%s runs none', line => {
    expect(runsLocalProgram(line)).toBe(false)
  })

  it('names ssh, scp and sftp as the programs it reads', () => {
    expect([...SSH_PROGRAMS]).toEqual(['ssh', 'scp', 'sftp'])
  })
})

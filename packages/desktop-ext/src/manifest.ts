export interface UserConfigField {
  readonly type: 'string' | 'number' | 'boolean' | 'directory' | 'file';
  readonly title: string;
  readonly description: string;
  readonly required: boolean;
  readonly sensitive?: boolean;
  readonly default?: string;
}

export interface DesktopManifest {
  readonly manifest_version: string;
  readonly name: string;
  readonly display_name: string;
  readonly version: string;
  readonly description: string;
  readonly author: { readonly name: string; readonly email: string };
  readonly license: string;
  readonly repository: { readonly type: string; readonly url: string };
  readonly icon: string;
  readonly server: {
    readonly type: 'node';
    readonly entry_point: string;
    readonly mcp_config: {
      readonly command: string;
      readonly args: readonly string[];
      readonly env: Readonly<Record<string, string>>;
    };
  };
  readonly user_config: Readonly<Record<string, UserConfigField>>;
  readonly compatibility: {
    readonly platforms: readonly string[];
    readonly runtimes: { readonly node: string };
  };
}

/** Claude Desktop substitutes `${user_config.<key>}` at launch time. */
function fromUserConfig(key: string): string {
  return `\${user_config.${key}}`;
}

export function buildManifest(version: string): DesktopManifest {
  return {
    manifest_version: '0.3',
    name: 'aiftp',
    display_name: 'aiftp — FTP/FTPS 安全デプロイ',
    version,
    description:
      'AI が書いたコードを FTP/FTPS/SFTP のレンタルサーバへ安全に反映します。自動バックアップ・2段確認・認証情報ファイルの構造的除外つき。',
    author: { name: 'Tanaka Yuichiro', email: 'u16.tanaka@gmail.com' },
    license: 'MIT',
    repository: { type: 'git', url: 'https://github.com/aiftp-tools/aiftp' },
    icon: 'icon.png',
    server: {
      type: 'node',
      entry_point: 'server/index.js',
      mcp_config: {
        command: 'node',
        args: ['${__dirname}/server/index.js'],
        env: {
          AIFTP_PROJECT_DIR: fromUserConfig('local_root'),
          AIFTP_BOOTSTRAP_SITE: fromUserConfig('site_name'),
          AIFTP_BOOTSTRAP_HOST: fromUserConfig('host'),
          AIFTP_BOOTSTRAP_PROTOCOL: fromUserConfig('protocol'),
          AIFTP_BOOTSTRAP_USER: fromUserConfig('username'),
          AIFTP_BOOTSTRAP_REMOTE_ROOT: fromUserConfig('remote_root'),
          AIFTP_BOOTSTRAP_CREDENTIAL: fromUserConfig('password'),
          AIFTP_CONFIRM_PHRASE: fromUserConfig('confirm_phrase'),
        },
      },
    },
    user_config: {
      site_name: {
        type: 'string',
        title: 'サイト名',
        description: '台帳での識別子。英数字・ドット・アンダースコア・ハイフンのみ（例: gwco）',
        required: true,
      },
      local_root: {
        type: 'directory',
        title: 'サイトフォルダ',
        description: 'あなたのサイトのファイルが入っているパソコン上のフォルダ',
        required: true,
      },
      host: {
        type: 'string',
        title: 'ホスト名',
        description: 'レンタルサーバの FTP ホスト名（例: ftp.example.jp）',
        required: true,
      },
      protocol: {
        type: 'string',
        title: 'プロトコル',
        description: 'ftps / sftp / ftp のいずれか。通常は ftps のままにしてください',
        required: false,
        default: 'ftps',
      },
      username: {
        type: 'string',
        title: 'ユーザー名',
        description: 'FTP のユーザー名',
        required: true,
      },
      remote_root: {
        type: 'string',
        title: 'サーバー側フォルダ',
        description: '公開ディレクトリ（例: /public_html）',
        required: true,
      },
      password: {
        type: 'string',
        title: 'パスワード',
        description:
          'FTP のパスワード。OS のキーチェーンに保存され、初回起動後はこの欄を空にしてかまいません',
        required: true,
        sensitive: true,
      },
      confirm_phrase: {
        type: 'string',
        title: '合言葉',
        description:
          '本番反映のときにあなた自身がチャットへ入力する合言葉。FTP のパスワードとは別の文字列にしてください',
        required: true,
        sensitive: true,
      },
    },
    compatibility: {
      platforms: ['darwin', 'win32'],
      runtimes: { node: '>=22.0.0' },
    },
  };
}

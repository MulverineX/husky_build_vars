/** These are what you need to modify for your pixel */
const build_vars = {
    MANUFACTURER: 'Google',
    MODEL: 'Pixel 8 Pro',
    FINGERPRINT: '',
    BRAND: 'google',
    PRODUCT: 'husky_beta',
    DEVICE: 'husky',
    RELEASE: '',
    ID: '',
    INCREMENTAL: '',
    TYPE: 'user',
    TAGS: 'release-keys',
    SECURITY_PATCH: '',
}

import { load } from 'cheerio'
import StreamZip from 'node-stream-zip'
import fsp from 'node:fs/promises'
import stream from 'node:stream'
import type cheerioModule from 'cheerio'
import type { StreamZipAsync } from 'node-stream-zip'

const loadCheerio = load as typeof cheerioModule['load']

const cheerio = loadCheerio('<html></html>', { '_useHtmlParser2': true })

const versions_page = cheerio(await (await fetch('https://developer.android.com/about/versions')).text())

const version_link = versions_page.find('div.devsite-mobile-nav-bottom > ul > li:nth-child(2) > a')!.attr('href')!

build_vars.RELEASE = `${version_link.slice(-2)}`

const beta_info_page = cheerio(await (await fetch(`https://developer.android.com${version_link}/get`)).text())

const codename = /system image, called (\w+), and click/.exec(beta_info_page.find('div.devsite-article-body.clearfix > ol:nth-child(25) > li:nth-child(6) > p')!.text())![1].toLowerCase()

const beta_images_page = cheerio(await (await fetch(`https://developer.android.com${version_link}/download`)).text())

const device_image = (beta_images_page.find(`#${build_vars.DEVICE} > td:nth-child(2) > button`)! as any)[0].children[0].data

const current_image = Bun.file('current_image')

/* @ts-ignore */
ReadableStream.prototype[Symbol.asyncIterator] = async function* () {
    const reader = this.getReader()
    try {
        while (true) {
            const { done, value } = await reader.read()
            if (done) return
            yield value
        }
    }
    finally {
        reader.releaseLock()
    }
}

if (await current_image.text() === device_image) {
    console.log('No new image available')
} else { // https://dl.google.com/developers/android/baklava/images/factory/husky_beta-bp22.250221.013-factory-9bf30a3a.zip
    const device_image_link = `https://dl.google.com/developers/android/${codename}/images/factory/${device_image}`

    const save_image_id = current_image.writer()

    save_image_id.write(device_image)

    await save_image_id.end()

    console.log(`New image available: ${device_image_link}`)

    console.log('Downloading...')

    const downloader = async () => {
        const req = await fetch(device_image_link)

        const size = Number(req.headers.get('content-length')!)

        const image = stream.Readable.fromWeb(req.body! as unknown as import("stream/web").ReadableStream<any>)

        let currentBytes = 0

        let currentPercentage = 0

        const writer = Bun.file('image.zip').writer()

        image.on('data', chunk => {
            currentBytes += Buffer.byteLength(chunk)

            const percentage = Math.floor((currentBytes / size) * 100)

            if (percentage % 5 === 0 && percentage !== currentPercentage) {
                console.log(`Download ${percentage}% complete`)

                currentPercentage = percentage
            }

            writer.write(chunk)
        })

        return new Promise<void>((res, rej) => {
            image.on('error', (error) => rej(error))

            image.on('end', async () => {
                await new Promise<void>((_res, _rej) => image._destroy(null, (error) => !error ? _res() : _rej(error))).catch(e => rej(e))

                await writer.end()

                res()
            })
        })
    }

    const image_file = Bun.file('image.zip')

    if (image_file.size < 3000000000) {
        await downloader()

        console.log('Downloaded')
    } else {
        console.log('Already downloaded')
    }

    console.log('Extracting...')

    if (!await fsp.exists('image')) {
        await fsp.mkdir('image')
    }

    const zip = new StreamZip.async({ file: 'image.zip' }) as StreamZipAsync

    const entries = await zip.entries()

    let internal_image = ''

    for (const entry of Object.values(entries)) {
        if (!entry.isDirectory && entry.name.includes('/image-')) {
            internal_image = entry.name
            break
        }
    }

    console.log(internal_image)

    await zip.extract(internal_image, 'image')

    await zip.close()

    const internal_zip = new StreamZip.async({ file: `image/${internal_image.split('/')[1]}` }) as StreamZipAsync

    await internal_zip.extract('system.img', 'image')

    await internal_zip.close()

    await Bun.$`7z x image/system.img system/build.prop`

    console.log('Extracted')

    console.log('Parsing build.prop...')

    const build_prop = (await Bun.file('system/build.prop').text()).split('\n')

    for (const line of build_prop) {
        if (line.startsWith('ro.system.build.fingerprint=')) {
            build_vars.FINGERPRINT = line.split('=')[1]
        } else if (line.startsWith('ro.system.build.id=')) {
            build_vars.ID = line.split('=')[1]
        } else if (line.startsWith('ro.system.build.version.incremental=')) {
            build_vars.INCREMENTAL = line.split('=')[1]
        } else if (line.startsWith('ro.build.version.security_patch=')) {
            build_vars.SECURITY_PATCH = line.split('=')[1]
        }

        if (build_vars.FINGERPRINT !== '' && build_vars.ID !== '' && build_vars.INCREMENTAL !== '' && build_vars.SECURITY_PATCH !== '') {
            break
        }
    }

    console.log('Parsed')

    console.log(build_vars)

    console.log('Writing...')

    const spoof_build_vars = Object.entries(build_vars).map(([key, value]) => `${key}=${value}`).join('\n')

    await Bun.write(Bun.file('spoof_build_vars'), spoof_build_vars)

    const patch_number = build_vars.SECURITY_PATCH.replaceAll('-', '')

    const security_patch = Object.entries({
        system: patch_number.substring(0, 6),
        vendor: build_vars.SECURITY_PATCH,
        all: patch_number
    }).map(([key, value]) => `${key}=${value}`).join('\n')

    await Bun.write(Bun.file('security_patch.txt'), security_patch)

    console.log('Build vars & security patch written')

    console.log('Notifying...')

    await fetch(
        process.env.DISCORD_WEBHOOK!,
        {
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                content: process.env.UPDATE_MESSAGE! + '\n\n```' + spoof_build_vars + '```\n```' + security_patch + '```'
            })
        }
    )

    console.log('Notified. Done!')
}


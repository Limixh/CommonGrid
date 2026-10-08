//go:build !windows

package artifact

import (
	"os"
	"reflect"
)

func unsafeVaultInfo(info os.FileInfo) bool {
	if info.Mode()&os.ModeSymlink != 0 {
		return true
	}
	// Unix file-info representations expose Nlink; reflection keeps this
	// portable across the supported Unix variants without platform casts.
	value := reflect.ValueOf(info.Sys())
	if value.IsValid() && value.Kind() == reflect.Pointer {
		value = value.Elem()
	}
	if value.IsValid() && value.Kind() == reflect.Struct {
		links := value.FieldByName("Nlink")
		if links.IsValid() {
			switch links.Kind() {
			case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
				if info.Mode().IsRegular() && links.Uint() != 1 {
					return true
				}
			case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
				if info.Mode().IsRegular() && links.Int() != 1 {
					return true
				}
			}
		}
	}
	return false
}

func checkVaultFile(file *os.File) error {
	info, err := file.Stat()
	if err != nil {
		return err
	}
	if unsafeVaultInfo(info) {
		return ErrVaultUnsafe
	}
	return nil
}
